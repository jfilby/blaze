/**
 * AI backends.
 *
 * The backend turns a function contract plus a target into an assembly
 * candidate. Model output is untrusted: it is recorded verbatim and handed to
 * the assembler for validation, never executed directly.
 *
 * Two backends implement the same contract:
 *
 *   - VercelAiBackend: the production backend, built on the Vercel AI SDK
 *   - ReplayBackend: an offline backend that returns recorded assembly, so the
 *     deterministic part of the pipeline (assembling, verifying, benchmarking,
 *     selection) can be exercised without network access or credentials
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { CompilerError } from "../core/errors.ts";
import type { ModelConfiguration } from "./model.ts";
import { buildRetryPrompt, buildSystemPrompt, buildUserPrompt, type PromptRequest } from "./prompt.ts";
import { DEFAULT_GENERATION, type AssemblyCandidate } from "../core/types.ts";

/**
 * A model call that did not produce an implementation: the provider request
 * failed, or the reply carried no assembly. It is not a candidate and not a
 * rejection of one, so the attempt is asked for again in place.
 */
class UnusableAnswer extends Error {
  /** Why the answer could not be used, told to the model on the re-request. */
  readonly reason: string;
  /** Whether asking again can change the outcome. */
  readonly retryable: boolean;
  /** What fails the build once the re-requests are spent. */
  readonly failure: CompilerError;
  /**
   * How the request that produced this answer ended, kept for a reply that
   * carried no implementation: an answer cut off by the output limit, one a
   * content filter took and one the model finished on its own are a different
   * failure from each other, and only the provider knows which it was, for
   * what it cost. Kept out of the reason, which the re-request prompt carries,
   * because a stop is a fact about the request the model cannot change by
   * being asked again. Absent for a request that never came back at all,
   * which is the one answer the provider has no account of.
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
   * Asks for one implementation. `sequence` is the position this answer takes
   * in the build's candidate record and names it; the request says which
   * candidate and attempt it belongs to.
   */
  generate(request: PromptRequest, sequence: number): Promise<AssemblyCandidate>;
}

function generationError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "AiGenerationError", stage: "generate", message, detail });
}

/**
 * Recovers the assembly from a model response: fenced blocks are unwrapped and
 * anything outside the first fence is dropped. The result is still untrusted.
 */
export function extractAssembly(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw generationError("the model returned an empty response");
  const fence = /```(?:[A-Za-z0-9_+-]*)\n([\s\S]*?)```/.exec(trimmed);
  const body = fence === null ? trimmed : fence[1];
  const assembly = body.trim();
  if (assembly === "") throw generationError("the model returned no assembly", trimmed.slice(0, 400));
  if (!/\S/.test(assembly.replace(/^\s*[#;].*$/gm, ""))) {
    throw generationError("the model returned only comments", assembly.slice(0, 400));
  }
  return `${assembly}\n`;
}

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
 * and a build that fails on an answer with nothing in it is the one place
 * they can still be read.
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

/** Exactly what is sent to a model for one attempt. */
export interface PromptDump {
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
  candidate: number;
  attempt: number;
  /** The re-request being made, 1-based. */
  retry: number;
  /** Re-requests this attempt is allowed in total. */
  retries: number;
  /** Why the answer before it could not be used. */
  reason: string;
  /** How the request behind it ended, when there was a request to end. */
  stop?: ProviderStop;
}

/**
 * How long the first re-request waits, doubling for each one after it: a
 * provider answering with nothing is usually busy, and an answer asked for
 * while it still is comes back the same.
 */
const RETRY_BACKOFF_MS = 500;

export interface BackendOptions {
  /**
   * Wall clock budget for one model request. Unset by default: a model that
   * thinks for a long time is not a failure, and the compiler says which model
   * it is waiting on. Set it when a build must fail rather than wait.
   */
  timeoutMs?: number;
  /**
   * Extra requests one attempt may spend on an answer that carries no
   * implementation. Defaults to `DEFAULT_GENERATION.maxRetries`.
   */
  retries?: number;
  /** Called before an answer is asked for again, with the reason for it. */
  onRetry?: (retry: ResponseRetry) => void;
  /** Called with the prompt before it is sent, for --debug. */
  onPrompt?: (dump: PromptDump) => void;
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
      if (baseURL === undefined) throw generationError(`${configuration.provider} has no endpoint`);
      this.model = createOpenAICompatible({
        name: configuration.provider,
        baseURL,
        apiKey,
        ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
      })(configuration.model);
    } else if (configuration.provider === "anthropic") {
      this.model = createAnthropic({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
    } else if (configuration.provider === "google") {
      this.model = createGoogleGenerativeAI({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
    } else {
      throw generationError(`provider "${configuration.provider}" cannot be used for generation`);
    }
    return this.model;
  }

  /**
   * Asks the model until it answers with an implementation or the re-request
   * budget is spent.
   *
   * A model that fails to answer, or answers with nothing, has not proposed
   * anything: there is nothing to assemble, verify, reject or repair, and the
   * next attempt of the candidate would be a repair of an output that does not
   * exist. Such an answer is asked for again in place instead, each time told
   * what was wrong with the one before it, and none of them costs the
   * candidate one of its repair attempts.
   */
  async generate(request: PromptRequest, sequence: number): Promise<AssemblyCandidate> {
    const system = buildSystemPrompt(request.output);
    const user = buildUserPrompt(request);
    this.onPrompt?.({ candidate: request.candidate, attempt: request.attempt, system, user });
    const model = await this.languageModel();
    const answers: { reason: string; stop: ProviderStop | undefined }[] = [];
    let assembly: string;

    for (let retry = 0; ; retry += 1) {
      try {
        assembly = await this.ask(model, system, answers.length === 0 ? user : buildRetryPrompt(user, answers.map((entry) => entry.reason)));
        break;
      } catch (cause) {
        if (!(cause instanceof UnusableAnswer)) throw cause;
        if (!cause.retryable) throw cause.failure;
        answers.push({ reason: cause.reason, stop: cause.stop });
        if (retry === this.retries) {
          throw new CompilerError({
            category: "AiGenerationError",
            stage: "generate",
            message: cause.failure.message,
            detail: [
              `asked ${this.retries + 1} times, and no answer carried an implementation:`,
              ...answers.map((entry) => `- ${entry.reason}${entry.stop === undefined ? "" : ` (${describeProviderStop(entry.stop)})`}`),
              ...(cause.failure.detail === undefined ? [] : [cause.failure.detail]),
            ].join("\n"),
          });
        }
        this.onRetry?.({
          candidate: request.candidate,
          attempt: request.attempt,
          retry: retry + 1,
          retries: this.retries,
          reason: cause.reason,
          ...(cause.stop === undefined ? {} : { stop: cause.stop }),
        });
        await sleep(RETRY_BACKOFF_MS * 2 ** retry);
      }
    }

    return {
      id: `c${sequence}`,
      assembly,
      model: this.id,
      modelConfig: this.id,
      generatedAt: new Date().toISOString(),
      candidate: request.candidate,
      round: request.attempt,
      ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
    };
  }

  /** One model call, answered in terms of the compiler: assembly, or none. */
  private async ask(model: LanguageModel, system: string, user: string): Promise<string> {
    let text: string;
    let stop: ProviderStop | undefined;
    try {
      // The system text goes in `instructions`, not a system message: that is
      // the portable form, and providers such as OpenRouter reject a system
      // message outright. A budget, when the project sets one, bounds this one
      // call; a re-request is asked for again, not run inside what is left.
      const result = await generateText({
        model,
        instructions: system,
        prompt: user,
        ...(this.timeoutMs === undefined ? {} : { abortSignal: AbortSignal.timeout(this.timeoutMs) }),
      });
      text = result.text;
      // How the request ended and what it cost, kept for a reply that turns
      // out to carry no implementation: a request that never came back with
      // one has neither to report.
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
          generationError(
            `the model did not answer within ${Math.round(this.timeoutMs / 1000)}s`,
            "remove generation.timeoutSeconds to wait as long as the model needs",
          ),
        );
      }
      throw new UnusableAnswer(
        "the provider request failed",
        true,
        generationError("the model provider request failed", cause instanceof Error ? cause.message : String(cause)),
      );
    }

    try {
      return extractAssembly(text);
    } catch (cause) {
      // A reply with no implementation in it is the model not answering, not a
      // wrong answer: the toolchain never saw anything to judge. The provider
      // stopped for its own reasons, and saying which is the only account of
      // why there is nothing here to reject.
      const failure = cause instanceof CompilerError ? cause : generationError("the model returned no implementation");
      throw new UnusableAnswer(failure.message, true, failure, stop);
    }
  }
}

/** The AI SDK wraps the abort; the name survives the wrapping. */
function isTimeout(cause: unknown): boolean {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") return true;
    if (cause.cause instanceof Error && (cause.cause.name === "TimeoutError" || cause.cause.name === "AbortError")) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Replay backend                                                             */
/* -------------------------------------------------------------------------- */

interface ReplayFile {
  candidates?: string[];
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
      throw generationError(
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
        throw generationError(`replay file ${file} is not valid JSON`, cause instanceof Error ? cause.message : String(cause));
      }
      if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
        throw generationError(`replay file ${file} must contain a non-empty "candidates" array`);
      }
      this.entries = parsed.candidates;
      return this.entries;
    }
    this.entries = [trimmed];
    return this.entries;
  }

  async generate(request: PromptRequest, sequence: number): Promise<AssemblyCandidate> {
    const entries = await this.load();
    // Answers are served by record position, not by a shared cursor: candidates
    // are generated at the same time, and a cursor would hand them out in
    // whatever order they happened to reach the backend.
    const entry = entries[Math.min(sequence - 1, entries.length - 1)];
    return {
      id: `c${sequence}`,
      assembly: extractAssembly(entry),
      model: this.id,
      modelConfig: this.id,
      generatedAt: new Date().toISOString(),
      candidate: request.candidate,
      round: request.attempt,
      ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createBackend(configuration: ModelConfiguration, options: BackendOptions = {}): AiBackend {
  if (configuration.provider === "replay") return new ReplayBackend(configuration);
  return new VercelAiBackend(configuration, options);
}

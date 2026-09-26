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
import { generateText, type LanguageModel } from "ai";
import { readFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import type { ModelConfiguration } from "./model.ts";
import { buildSystemPrompt, buildUserPrompt, type PromptRequest } from "./prompt.ts";
import type { AssemblyCandidate } from "../core/types.ts";

export interface AiBackend {
  /** Recorded in build records. */
  readonly id: string;
  generate(request: PromptRequest, attempt: number): Promise<AssemblyCandidate>;
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

/* -------------------------------------------------------------------------- */
/* Vercel AI SDK backend                                                      */
/* -------------------------------------------------------------------------- */

/** Exactly what is sent to a model for one attempt. */
export interface PromptDump {
  attempt: number;
  system: string;
  user: string;
}

export interface BackendOptions {
  /**
   * Wall clock budget for one model request. Unset by default: a model that
   * thinks for a long time is not a failure, and the compiler says which model
   * it is waiting on. Set it when a build must fail rather than wait.
   */
  timeoutMs?: number;
  /** Called with the prompt before it is sent, for --debug. */
  onPrompt?: (dump: PromptDump) => void;
}

export class VercelAiBackend implements AiBackend {
  readonly id: string;
  private readonly configuration: ModelConfiguration;
  private readonly timeoutMs: number | undefined;
  private readonly onPrompt: ((dump: PromptDump) => void) | undefined;
  private model: LanguageModel | null = null;

  constructor(configuration: ModelConfiguration, options: BackendOptions = {}) {
    this.configuration = configuration;
    this.timeoutMs = options.timeoutMs;
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

  async generate(request: PromptRequest, attempt: number): Promise<AssemblyCandidate> {
    const system = buildSystemPrompt();
    const user = buildUserPrompt(request);
    this.onPrompt?.({ attempt, system, user });

    const model = await this.languageModel();
    let text: string;
    try {
      // The system text goes in `instructions`, not a system message: that is
      // the portable form, and providers such as OpenRouter reject a system
      // message outright. A budget, when the project sets one, bounds the whole
      // call including retries.
      const result = await generateText({
        model,
        instructions: system,
        prompt: user,
        ...(this.timeoutMs === undefined ? {} : { abortSignal: AbortSignal.timeout(this.timeoutMs) }),
      });
      text = result.text;
    } catch (cause) {
      if (isTimeout(cause) && this.timeoutMs !== undefined) {
        throw generationError(
          `the model did not answer within ${Math.round(this.timeoutMs / 1000)}s`,
          "remove generation.timeoutSeconds to wait as long as the model needs",
        );
      }
      throw generationError(
        "the model provider request failed",
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    return {
      id: `c${attempt}`,
      assembly: extractAssembly(text),
      model: this.id,
      modelConfig: this.id,
      generatedAt: new Date().toISOString(),
      round: attempt,
      ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
    };
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
  private cursor = 0;

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

  async generate(request: PromptRequest, attempt: number): Promise<AssemblyCandidate> {
    const entries = await this.load();
    const entry = entries[Math.min(this.cursor, entries.length - 1)];
    this.cursor += 1;
    return {
      id: `c${attempt}`,
      assembly: extractAssembly(entry),
      model: this.id,
      modelConfig: this.id,
      generatedAt: new Date().toISOString(),
      round: attempt,
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

/**
 * Model configuration.
 *
 * The compiler contains no provider-specific logic beyond resolving which
 * provider package to construct and with which credentials. The selection comes
 * from CLI options or the environment:
 *
 *   AI_MODEL=openai/gpt-5            Vercel AI SDK provider + model id
 *   AI_MODEL=anthropic/claude-sonnet-4-5
 *   AI_MODEL=google/gemini-2.5-pro
 *   AI_MODEL=openrouter/anthropic/claude-sonnet-4.5
 *   AI_MODEL=openai-compatible/my-model   with AI_BASE_URL
 *   AI_MODEL=replay:./candidate.json      offline backend, see backend.ts
 *
 *   AI_API_KEY      generic credential
 *   OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
 *   OPENROUTER_API_KEY  enables the openrouter provider
 *   AI_BASE_URL     endpoint for openai-compatible providers
 *   AI_REPLAY_FILE  default file for the replay backend
 *   OPENROUTER_SITE_URL, OPENROUTER_APP_NAME  optional OpenRouter attribution
 */

import { CompilerError } from "../core/errors.ts";

export type ProviderName = "openai" | "anthropic" | "google" | "openrouter" | "openai-compatible" | "replay";

/** OpenRouter serves every model behind one OpenAI compatible endpoint. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ModelConfiguration {
  /** Recorded in build records for reproducibility. */
  readonly id: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Extra request headers, such as the attribution OpenRouter accepts. */
  readonly headers?: Record<string, string>;
  /** Assembly file used by the offline replay backend. */
  readonly replayFile?: string;
}

const ENV_KEYS: Record<ProviderName, readonly string[]> = {
  openai: ["OPENAI_API_KEY", "AI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "AI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "AI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "AI_API_KEY"],
  "openai-compatible": ["AI_API_KEY"],
  replay: [],
};

function generationError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "AiGenerationError", stage: "generate", message, detail });
}

function firstEnvKey(provider: ProviderName, env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ENV_KEYS[provider]) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Resolves the model configuration from an explicit spec and the environment.
 * A missing or malformed configuration fails loudly instead of silently
 * producing a compiler that cannot generate anything.
 */
export function resolveModel(spec: string | undefined, env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const requested = spec ?? env.AI_MODEL ?? "";
  if (requested === "") {
    throw generationError(
      "no model configured",
      "set AI_MODEL (for example AI_MODEL=openai/gpt-5) or pass --model provider/model",
    );
  }

  if (requested.startsWith("replay:")) {
    const replayFile = requested.slice("replay:".length) || env.AI_REPLAY_FILE;
    if (replayFile === undefined || replayFile === "") {
      throw generationError("replay backend needs a file", "use AI_MODEL=replay:./candidate.json or set AI_REPLAY_FILE");
    }
    return { id: `replay:${replayFile}`, provider: "replay", model: replayFile, replayFile };
  }

  const separator = requested.indexOf("/");
  if (separator <= 0 || separator === requested.length - 1) {
    throw generationError(
      `invalid model "${requested}"`,
      "expected provider/model, for example openai/gpt-5, anthropic/claude-sonnet-4-5 or replay:./candidate.json",
    );
  }

  const provider = requested.slice(0, separator);
  const model = requested.slice(separator + 1);
  if (!Object.prototype.hasOwnProperty.call(ENV_KEYS, provider)) {
    throw generationError(
      `unknown provider "${provider}"`,
      `known providers: ${Object.keys(ENV_KEYS).join(", ")}`,
    );
  }
  const name = provider as ProviderName;
  const apiKey = firstEnvKey(name, env);
  if (apiKey === undefined) {
    throw generationError(
      `missing API key for provider "${provider}"`,
      `set one of ${ENV_KEYS[name].join(", ")}`,
    );
  }
  const baseUrl = name === "openrouter" ? OPENROUTER_BASE_URL : name === "openai-compatible" ? env.AI_BASE_URL : undefined;
  if (name === "openai-compatible" && baseUrl === undefined) {
    throw generationError("openai-compatible needs AI_BASE_URL", "point it at the provider endpoint");
  }
  // OpenRouter attributes requests to the app that made them when these are set.
  const headers: Record<string, string> = {};
  if (env.OPENROUTER_SITE_URL !== undefined && env.OPENROUTER_SITE_URL !== "") headers["HTTP-Referer"] = env.OPENROUTER_SITE_URL;
  if (env.OPENROUTER_APP_NAME !== undefined && env.OPENROUTER_APP_NAME !== "") headers["X-Title"] = env.OPENROUTER_APP_NAME;

  return {
    id: requested,
    provider: name,
    model,
    apiKey,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

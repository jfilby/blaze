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
 *   AI_MODEL=opencode/grok-code           OpenCode Zen, see backend.ts
 *   AI_MODEL=openai-compatible/my-model   with AI_BASE_URL
 *   AI_MODEL=commandcode/stealth/pixel-canary  CommandCode, see commandcode.ts
 *   AI_MODEL=replay:./candidate.json      offline backend, see backend.ts
 *
 *   AI_API_KEY, OPENCODE_API_KEY      generic credentials
 *   OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
 *   OPENROUTER_API_KEY  enables the openrouter provider
 *   OPENCODE_API_KEY  enables the opencode provider
 *   OPENCODE_BASE_URL endpoint for opencode
 *   AI_BASE_URL     endpoint for openai-compatible providers
 *   AI_REPLAY_FILE  default file for the replay backend
 *   OPENROUTER_SITE_URL, OPENROUTER_APP_NAME  optional OpenRouter attribution
 *   COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY  enables the commandcode provider
 */

import { CompilerError } from "../core/errors.ts";
import { COMMANDCODE_BASE_URL } from "./commandcode.ts";

export type ProviderName = "openai" | "anthropic" | "google" | "openrouter" | "opencode" | "openai-compatible" | "commandcode" | "replay";

/** OpenRouter serves every model behind one OpenAI compatible endpoint. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenCode Zen serves its curated models behind one OpenAI compatible endpoint. */
export const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";

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
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "openai-compatible": [],
  commandcode: ["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"],
  replay: [],
};

/**
 * A provider with no key of its own set reads one of these, in this order:
 * the compiler's own generic credential and then the one the environment
 * already carries. Read after every provider key in `ENV_KEYS`.
 */
const GENERIC_ENV_KEYS: readonly string[] = ["AI_API_KEY", "OPENCODE_API_KEY"];

function generationError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "AiReviewError", stage: "review", message, detail });
}

function firstEnvKey(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
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
  const apiKey = firstEnvKey(env, ENV_KEYS[name]) ?? firstEnvKey(env, GENERIC_ENV_KEYS);
  if (apiKey === undefined) {
    throw generationError(
      `missing API key for provider "${provider}"`,
      `set one of ${[...ENV_KEYS[name], ...GENERIC_ENV_KEYS].join(", ")}`,
    );
  }
  const baseUrl =
    name === "openrouter"
      ? OPENROUTER_BASE_URL
      : name === "commandcode"
        // Pointable at a relay in front of CommandCode, or at a stand-in for
        // one, which is where a test drives this provider from.
        ? env.COMMANDCODE_BASE_URL || COMMANDCODE_BASE_URL
        : name === "opencode"
          // Pointable at a stand-in for Zen, which is where a test drives
          // this provider from.
          ? env.OPENCODE_BASE_URL || OPENCODE_BASE_URL
          : name === "openai-compatible"
            ? env.AI_BASE_URL
            : undefined;
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

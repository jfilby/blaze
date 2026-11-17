/**
 * The model boundary a native build carries.
 *
 * An ordinary `blaze build` needs no model: it runs the rules alone, lowers the
 * IR it resolved, verifies it and reviews nothing. This adapter is the file a
 * native project maps `#host/model` to (the host boundary of the self-building
 * spec); it refuses only a provider the caller asked for explicitly, because a
 * native binary carries no network transport. That is not a prerequisite for
 * self-building: compiling the compiler does not ask a model anything.
 */

import { CompilerError } from "../core/errors.ts";
import type { AiBackend, BackendOptions } from "./backend.ts";
import type { ModelConfiguration } from "./model.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** The backend a provider configuration constructs on a native host. */
export function createSdkBackend(configuration: ModelConfiguration, _options: BackendOptions = {}): AiBackend {
  throw new CompilerError("AiReviewError", "review", `the ${String(fieldOf(configuration, "provider"))} provider needs a transport this build does not carry`, "a native build needs no model: leave --model and AI_MODEL unset to run the rules alone; only an explicitly requested provider reaches this boundary", "", "", "");
}

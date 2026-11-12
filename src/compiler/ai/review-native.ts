/**
 * The model transport a native build carries.
 *
 * The first fixed point uses `--model replay`, which the compiler answers
 * itself without a host, so this adapter refuses every provider that would need
 * the network. It is the file a native project maps `#host/model` to (the host
 * boundary of the self-hosting spec); the HTTP transport replaces it when model
 * review is ported, not before.
 */

import { CompilerError } from "../core/errors.ts";
import type { AiBackend, BackendOptions } from "./backend.ts";
import type { ModelConfiguration } from "./model.ts";

/** The backend a provider configuration constructs on a native host. */
export function createSdkBackend(configuration: ModelConfiguration, _options: BackendOptions = {}): AiBackend {
  throw new CompilerError({
    category: "AiReviewError",
    stage: "review",
    message: `the ${configuration.provider} provider needs a transport this build does not carry`,
    detail: "build with --model replay; provider review is the last host service a native compiler gains",
  });
}

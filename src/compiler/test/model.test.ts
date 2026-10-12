import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewRequest } from "../ai/review.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { resolveModel, OPENROUTER_BASE_URL, OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "../ai/model.ts";
import { CompilerError } from "../core/errors.ts";
import { createBackend, ReplayBackend, VercelAiBackend } from "../ai/backend.ts";
import { chatEndpoint } from "./model-endpoint.ts";
import { scratch } from "./scratch.ts";

function diagnostic(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof CompilerError ? `${error.message}\n${error.detail ?? ""}` : String(error);
  }
  return "";
}

test("OPENROUTER_API_KEY configures the openrouter provider", () => {
  const configuration = resolveModel("openrouter/anthropic/claude-sonnet-4.5", { OPENROUTER_API_KEY: "sk-or-test" });
  assert.equal(configuration.provider, "openrouter");
  assert.equal(configuration.id, "openrouter/anthropic/claude-sonnet-4.5");
  assert.equal(configuration.model, "anthropic/claude-sonnet-4.5", "a vendor prefix stays part of the model id");
  assert.equal(configuration.apiKey, "sk-or-test");
  assert.equal(configuration.baseUrl, OPENROUTER_BASE_URL);
});

test("AI_MODEL selects openrouter without a --model flag", () => {
  const configuration = resolveModel(undefined, {
    AI_MODEL: "openrouter/qwen/qwen3-coder",
    OPENROUTER_API_KEY: "sk-or-test",
  });
  assert.equal(configuration.id, "openrouter/qwen/qwen3-coder");
});

test("openrouter falls back to the generic credential", () => {
  const configuration = resolveModel("openrouter/openai/gpt-5", { AI_API_KEY: "sk-generic" });
  assert.equal(configuration.apiKey, "sk-generic");
});

test("OPENCODE_API_KEY is read as a generic credential", () => {
  assert.equal(resolveModel("openrouter/openai/gpt-5", { OPENCODE_API_KEY: "sk-opencode" }).apiKey, "sk-opencode");
  assert.equal(
    resolveModel("openai-compatible/local", { OPENCODE_API_KEY: "k", AI_BASE_URL: "http://localhost:1234/v1" }).apiKey,
    "k",
  );
  // The compiler's own generic credential is read first where both are set.
  assert.equal(resolveModel("openrouter/openai/gpt-5", { AI_API_KEY: "a", OPENCODE_API_KEY: "b" }).apiKey, "a");
});

test("OPENCODE_API_KEY configures the opencode-go provider", () => {
  const configuration = resolveModel("opencode-go/glm-5.3-flash:max", { OPENCODE_API_KEY: "oc_test" });
  assert.equal(configuration.provider, "opencode-go");
  assert.equal(configuration.id, "opencode-go/glm-5.3-flash:max");
  assert.equal(configuration.model, "glm-5.3-flash:max");
  assert.equal(configuration.apiKey, "oc_test");
  assert.equal(configuration.baseUrl, OPENCODE_GO_BASE_URL);
  // The gateway routes by the session a request belongs to and refuses one
  // that names none, so a build carries an id of its own.
  assert.match(
    configuration.headers?.["x-opencode-session"] ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("opencode-go is pointable at a stand-in endpoint", () => {
  const configuration = resolveModel("opencode-go/glm-5.3-flash:max", {
    OPENCODE_API_KEY: "oc_test",
    OPENCODE_GO_BASE_URL: "http://127.0.0.1:9/zen/go/v1",
  });
  assert.equal(configuration.baseUrl, "http://127.0.0.1:9/zen/go/v1");
});

test("an opencode-go model object is constructible without contacting it", () => {
  // The endpoint is only reached on a request, so this proves the provider
  // package accepts the configuration the resolver produced.
  const backend = createBackend(resolveModel("opencode-go/glm-5.3-flash:max", { OPENCODE_API_KEY: "oc_test" }));
  assert.ok(backend instanceof VercelAiBackend);
  assert.equal(backend.id, "opencode-go/glm-5.3-flash:max");
});

test("OPENCODE_API_KEY configures the opencode-zen provider", () => {
  const configuration = resolveModel("opencode-zen/deepseek-v4-pro", { OPENCODE_API_KEY: "oc_test" });
  assert.equal(configuration.provider, "opencode-zen");
  assert.equal(configuration.id, "opencode-zen/deepseek-v4-pro");
  assert.equal(configuration.model, "deepseek-v4-pro");
  assert.equal(configuration.apiKey, "oc_test");
  assert.equal(configuration.baseUrl, OPENCODE_ZEN_BASE_URL);
  // The relay is the one the model was named for, not the one its sibling
  // serves: a model id is only valid on the relay that lists it.
  assert.notEqual(configuration.baseUrl, OPENCODE_GO_BASE_URL);
  // Same route as Go: the gateway pins a conversation to one backend, which is
  // what keeps a build's prompt cache warm.
  assert.match(
    configuration.headers?.["x-opencode-session"] ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("opencode-zen is pointable at a stand-in endpoint", () => {
  const configuration = resolveModel("opencode-zen/deepseek-v4-pro", {
    OPENCODE_API_KEY: "oc_test",
    OPENCODE_ZEN_BASE_URL: "http://127.0.0.1:9/zen/v1",
  });
  assert.equal(configuration.baseUrl, "http://127.0.0.1:9/zen/v1");
});

test("the two OpenCode relays are separate providers over one credential", () => {
  const env = { OPENCODE_API_KEY: "oc_test" };
  assert.equal(resolveModel("opencode-go/glm-5.3-flash:max", env).baseUrl, OPENCODE_GO_BASE_URL);
  assert.equal(resolveModel("opencode-zen/deepseek-v4-pro", env).baseUrl, OPENCODE_ZEN_BASE_URL);
  // Neither relay's stand-in leaks into the other: pointing one elsewhere is
  // not pointing both.
  const go = resolveModel("opencode-go/glm-5.3-flash:max", { ...env, OPENCODE_GO_BASE_URL: "http://127.0.0.1:9/go" });
  const zen = resolveModel("opencode-zen/deepseek-v4-pro", { ...env, OPENCODE_ZEN_BASE_URL: "http://127.0.0.1:9/zen" });
  assert.equal(go.baseUrl, "http://127.0.0.1:9/go");
  assert.equal(zen.baseUrl, "http://127.0.0.1:9/zen");
});

test("an opencode-zen model object is constructible without contacting it", () => {
  // The endpoint is only reached on a request, so this proves the provider
  // package accepts the configuration the resolver produced.
  const backend = createBackend(resolveModel("opencode-zen/deepseek-v4-pro", { OPENCODE_API_KEY: "oc_test" }));
  assert.ok(backend instanceof VercelAiBackend);
  assert.equal(backend.id, "opencode-zen/deepseek-v4-pro");
});

/** A review that finds nothing to change, which is what most rounds answer. */
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

test("a review asked of OpenCode Zen reaches its relay with the session header", async (t) => {
  const endpoint = await chatEndpoint(t, [SOUND]);
  const previous = { key: process.env.OPENCODE_API_KEY, url: process.env.OPENCODE_ZEN_BASE_URL };
  process.env.OPENCODE_API_KEY = "oc_test";
  process.env.OPENCODE_ZEN_BASE_URL = endpoint.url;
  t.after(() => {
    for (const [name, value] of [
      ["OPENCODE_API_KEY", previous.key],
      ["OPENCODE_ZEN_BASE_URL", previous.url],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // The backend is the one a build uses, so the request below is the one a build
  // makes: the wire format, the credential and the headers are the provider's,
  // and only the endpoint is the stand-in's.
  const review = await createBackend(resolveModel("opencode-zen/deepseek-v4-pro", process.env)).review(
    reviewRequest(),
    1,
  );

  assert.equal(review.verdict, "sound");
  // The chat completions path, not the responses or messages one: a Zen model
  // on another wire is a different provider, and this is the one the OpenAI
  // compatible package asks at.
  assert.equal(endpoint.requests[0]?.url, "/v1/chat/completions");
  assert.equal(endpoint.requests[0]?.authorization, "Bearer oc_test");
  assert.match(endpoint.requests[0]?.session ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("openrouter without a key fails with the names to set", () => {
  const message = diagnostic(() => resolveModel("openrouter/openai/gpt-5", {}));
  assert.match(message, /missing API key for provider "openrouter"/);
  assert.match(message, /OPENROUTER_API_KEY/);
});

test("OpenRouter attribution headers are sent when configured", () => {
  const configuration = resolveModel("openrouter/openai/gpt-5", {
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_SITE_URL: "https://example.test",
    OPENROUTER_APP_NAME: "blaze",
  });
  assert.deepEqual(configuration.headers, { "HTTP-Referer": "https://example.test", "X-Title": "blaze" });
});

test("no attribution is invented when none is configured", () => {
  const configuration = resolveModel("openrouter/openai/gpt-5", { OPENROUTER_API_KEY: "sk-or-test" });
  assert.equal(configuration.headers, undefined);
});

test("every provider is selected by its prefix and validated", () => {
  assert.equal(resolveModel("openai/gpt-5", { OPENAI_API_KEY: "k" }).provider, "openai");
  assert.equal(resolveModel("anthropic/claude-sonnet-4-5", { ANTHROPIC_API_KEY: "k" }).provider, "anthropic");
  assert.equal(resolveModel("google/gemini-2.5-pro", { GOOGLE_GENERATIVE_AI_API_KEY: "k" }).provider, "google");
  assert.equal(resolveModel("opencode-zen/deepseek-v4-pro", { OPENCODE_API_KEY: "k" }).provider, "opencode-zen");
  assert.equal(
    resolveModel("openai-compatible/local-model", { AI_API_KEY: "k", AI_BASE_URL: "http://localhost:1234/v1" }).baseUrl,
    "http://localhost:1234/v1",
  );
  assert.match(diagnostic(() => resolveModel("", {})), /no model configured/);
  assert.match(diagnostic(() => resolveModel("gpt-5", { AI_API_KEY: "k" })), /invalid model/);
  assert.match(diagnostic(() => resolveModel("cohere/command-r", { AI_API_KEY: "k" })), /unknown provider "cohere"/);
  assert.match(
    diagnostic(() => resolveModel("openai-compatible/local", { AI_API_KEY: "k" })),
    /openai-compatible needs AI_BASE_URL/,
  );
});

test("openrouter and replay build backends of the right kind", () => {
  const openrouter = resolveModel("openrouter/openai/gpt-5", { OPENROUTER_API_KEY: "sk-or-test" });
  assert.ok(createBackend(openrouter) instanceof VercelAiBackend);
  const replay = resolveModel("replay:./candidate.json", {});
  assert.equal(createBackend(replay).id, "replay:./candidate.json");
});

test("an openrouter model object is constructible without contacting it", () => {
  // The endpoint is only reached on a request, so this proves the provider
  // package accepts the configuration the resolver produced.
  const configuration = resolveModel("openrouter/anthropic/claude-sonnet-4.5", { OPENROUTER_API_KEY: "sk-or-test" });
  const backend = createBackend(configuration);
  assert.equal(backend.id, configuration.id);
});

/** The one request the replay backend is asked, which it never reads. */
function reviewRequest(): ReviewRequest {
  const files = {
    "main.ts": "import { dotProduct } from './lib.ts';\nconsole.log(dotProduct(1));\n",
    "lib.ts": "export function dotProduct(a: Float64Array, n: number): number {\n  return a[0] * n;\n}\n",
  };
  const phase = phaseOf("typescript", files, "main.ts");
  const contract = phase.program.files.find((file) => file.path === "lib.ts")?.functions.dotProduct;
  assert.ok(contract !== undefined);
  return {
    stage: "ir",
    contract,
    unit: { file: "lib.ts", function: "dotProduct" },
    program: phase.program,
    semantics: semanticsOf(phase),
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "machine",
    candidate: 1,
    candidates: 1,
    attempt: 1,
    artifact: "",
    artifactNote: null,
    feedback: [],
    refusals: [],
  };
}

test("the replay backend serves a recorded review, and refuses a file that holds none", async () => {
  const directory = await scratch("blaze-replay-");
  const file = join(directory, "reviews.json");
  await writeFile(file, JSON.stringify({ reviews: ["verdict: sound\nreason: nothing to change"] }), "utf8");
  const backend = createBackend(resolveModel(`replay:${file}`, {}));
  assert.ok(backend instanceof ReplayBackend);

  const review = await backend.review(reviewRequest(), 1);
  assert.equal(review.verdict, "sound");

  // A replay file that is not a file of reviews is refused before it is read
  // for an answer, so a build that meant to replay reviews is not silently
  // answered with whatever the file happened to hold.
  await writeFile(file, JSON.stringify({ candidates: ["function dotProduct() {}"] }), "utf8");
  const other = createBackend(resolveModel(`replay:${file}`, {}));
  await assert.rejects(() => other.review(reviewRequest(), 1), /must contain a non-empty "reviews" array/);
});

test("a replay entry that is not a review fails the build where it was served", async () => {
  const directory = await scratch("blaze-replay-bad-");
  const file = join(directory, "reviews.json");
  await writeFile(file, "here is the function you asked for\nfunction dotProduct() {}", "utf8");
  const backend = createBackend(resolveModel(`replay:${file}`, {}));
  await assert.rejects(
    () => backend.review(reviewRequest(), 1),
    /replay entry 1 is not a review of the ir of dotProduct/,
  );
});


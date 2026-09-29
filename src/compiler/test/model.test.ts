import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewRequest } from "../ai/review.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { resolveModel, OPENROUTER_BASE_URL } from "../ai/model.ts";
import { CompilerError } from "../core/errors.ts";
import { createBackend, ReplayBackend, VercelAiBackend } from "../ai/backend.ts";

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
  const directory = await mkdtemp(join(tmpdir(), "blaze-replay-"));
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
  const directory = await mkdtemp(join(tmpdir(), "blaze-replay-bad-"));
  const file = join(directory, "reviews.json");
  await writeFile(file, "here is the function you asked for\nfunction dotProduct() {}", "utf8");
  const backend = createBackend(resolveModel(`replay:${file}`, {}));
  await assert.rejects(
    () => backend.review(reviewRequest(), 1),
    /replay entry 1 is not a review of the ir of dotProduct/,
  );
});

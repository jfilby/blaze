import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModel, OPENROUTER_BASE_URL } from "../ai/model.ts";
import { CompilerError } from "../core/errors.ts";
import { createBackend, extractImplementation, readFailureStatus, VercelAiBackend } from "../ai/backend.ts";

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

test("the implementation is recovered from a fenced or bare response", () => {
  // Surrounding blank space and fence markers are removed; the instructions
  // themselves are passed through untouched.
  const fenced = extractImplementation("Here you go:\n```asm\n\t.globl f\nf:\n\tret\n```\n");
  assert.equal(fenced, ".globl f\nf:\n\tret\n");
  assert.equal(extractImplementation("  \t.globl f\n  "), ".globl f\n");
  assert.match(diagnostic(() => extractImplementation("   ")), /empty response/);
  assert.match(diagnostic(() => extractImplementation("# just a comment\n")), /only comments/);
});

test("a failure status is read off the first line, with the model's own words", () => {
  const declared = readFailureStatus("STATUS: failed\nThe contract requires behavior that cannot be implemented\nwith the available information.\n");
  assert.equal(
    declared?.message,
    "The contract requires behavior that cannot be implemented\nwith the available information.",
  );
  // A model that indents its status still means it, and the blank lines it
  // leaves around the report are not part of what it reported.
  assert.equal(readFailureStatus("  STATUS: failed  \r\n\r\nI cannot meet this.\r\n")?.message, "I cannot meet this.");
  // A status with nothing under it reports nothing, and says so by being
  // empty rather than by being absent.
  assert.equal(readFailureStatus("STATUS: failed")?.message, "");
});

test("only a first line that is exactly the status opens a failure", () => {
  // Everything else is source. A reply that mentions the status later, or
  // says it beside code, is what the toolchain is there to judge.
  assert.equal(readFailureStatus("```asm\n\t.globl f\nf:\n\tret\n```"), null);
  assert.equal(readFailureStatus("STATUS: ok\n\t.globl f"), null);
  assert.equal(readFailureStatus("I cannot do this.\nSTATUS: failed"), null);
  assert.equal(readFailureStatus("STATUS: failed to compile\treason"), null);
  assert.equal(readFailureStatus("Here is the function.\nSTATUS: failed\nbecause"), null);
});

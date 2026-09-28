/**
 * The CommandCode provider, driven against a stand-in for the generate
 * endpoint, so the whole path is exercised: a project names the provider, the
 * resolver reads the credential, the backend builds the model, the request
 * goes out in the envelope the endpoint takes, and the answer comes back as
 * events the compiler can read.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, streamText } from "ai";
import { runBuild } from "../compiler.ts";
import { resolveModel } from "../ai/model.ts";
import { COMMANDCODE_BASE_URL, COMMANDCODE_CLI_VERSION, createCommandCode } from "../ai/commandcode.ts";
import type { SourceInput } from "../core/types.ts";
import { z } from "zod";
import { CompilerError } from "../core/errors.ts";
import { writeProject } from "./project.ts";

const quiet = { stage: () => {} };
const SQUARE = "export function square(x: number): number {\n  return x * x;\n}\n";
/** x arrives in xmm0 as a double; the contract asks for x * x. */
const SQUARE_ASSEMBLY = ["\t.globl\tsquare", "square:", "\tmulsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

/** The shape of the request the endpoint was sent, read back out of it. */
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: {
    threadId?: string;
    params?: {
      model?: string;
      system?: string;
      max_tokens?: number;
      stream?: boolean;
      messages?: { role: string; content: string }[];
    };
  };
}

export interface GenerateEndpoint {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly received: Promise<void>;
}

export interface EndpointAnswer {
  /** Events sent as the answer, one per line. */
  readonly events: readonly unknown[];
  /** Frame the events the way an SSE endpoint does: `data: ` prefixed lines. */
  readonly asEvents?: boolean;
  /** Refuse the request instead of answering it. */
  readonly refusal?: { status: number; body: unknown };
  /** Stop the answer short of the event that ends it. */
  readonly truncated?: boolean;
}

export interface EndpointOptions {
  /** Answers, one per request, the last one repeated once they run out. */
  readonly answers?: readonly EndpointAnswer[];
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly finishReason?: string;
}

/**
 * A stand-in for the generate endpoint. It answers in the framing the endpoint
 * answers in, and says what it was sent so a test can read the request back.
 */
async function generateEndpoint(t: TestContext, options: EndpointOptions = {}): Promise<GenerateEndpoint> {
  const requests: RecordedRequest[] = [];
  const arrived = Promise.withResolvers<void>();
  let served = 0;

  const answer = (response: ServerResponse, body: string): void => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const line of body === "" ? [] : body.split("\n")) response.write(`${line}\n`);
    response.end();
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as RecordedRequest["body"],
      });
      const given = options.answers?.[Math.min(served, (options.answers?.length ?? 1) - 1)];
      served += 1;
      arrived.resolve();
      if (given === undefined) return;

      if (given.refusal !== undefined) {
        response.writeHead(given.refusal.status, { "content-type": "application/json" });
        response.end(JSON.stringify(given.refusal.body));
        return;
      }
      const usage = options.usage ?? { inputTokens: 11, outputTokens: 4 };
      const events = [...given.events];
      if (!given.truncated) {
        events.push({
          type: "finish",
          finishReason: options.finishReason ?? "stop",
          totalUsage: { ...usage, cachedInputTokens: 0 },
        });
      }
      events.push({ type: "finish-step", finishReason: options.finishReason ?? "stop", usage });
      const lines = events.map((event) => (given.asEvents === true ? `data: ${JSON.stringify(event)}` : JSON.stringify(event)));
      answer(response, [...lines, ": keepalive", "[DONE]"].join("\n"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return { url: `http://127.0.0.1:${port}`, requests, received: arrived.promise };
}

/** The model the resolver builds for a stand-in endpoint, without the project. */
function modelAt(url: string, modelId = "stealth/pixel-canary") {
  const configuration = resolveModel(`commandcode/${modelId}`, {
    COMMANDCODE_API_KEY: "user_test",
    COMMANDCODE_BASE_URL: url,
  });
  return createCommandCode({
    apiKey: configuration.apiKey ?? "",
    baseUrl: configuration.baseUrl ?? COMMANDCODE_BASE_URL,
  })(configuration.model);
}

test("COMMANDCODE_API_KEY configures the commandcode provider", () => {
  const configuration = resolveModel("commandcode/stealth/pixel-canary", { COMMANDCODE_API_KEY: "user_test" });
  assert.equal(configuration.provider, "commandcode");
  assert.equal(configuration.id, "commandcode/stealth/pixel-canary");
  // A vendor prefix stays part of the model id: this endpoint namespaces them.
  assert.equal(configuration.model, "stealth/pixel-canary");
  assert.equal(configuration.apiKey, "user_test");
  assert.equal(configuration.baseUrl, COMMANDCODE_BASE_URL);
});

/** The message and the detail, which is where a failure says what to set. */
function diagnostic(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof CompilerError ? `${error.message}\n${error.detail ?? ""}` : String(error);
  }
  return "";
}

test("the credential is read from either spelling, or the generic one", () => {
  assert.equal(resolveModel("commandcode/stealth/pixel-canary", { COMMAND_CODE_API_KEY: "k" }).apiKey, "k");
  assert.equal(resolveModel("commandcode/stealth/pixel-canary", { AI_API_KEY: "k" }).apiKey, "k");
  const message = diagnostic(() => resolveModel("commandcode/stealth/pixel-canary", {}));
  assert.match(message, /missing API key for provider "commandcode"/);
  assert.match(message, /COMMANDCODE_API_KEY/);
});

test("a request goes to the generate endpoint as the envelope it takes", async (t) => {
  const endpoint = await generateEndpoint(t, { answers: [{ events: [{ type: "text-delta", text: "ok" }] }] });

  await generateText({ model: modelAt(endpoint.url), instructions: "the system prompt", prompt: "the question" });

  const [request] = endpoint.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/alpha/generate");
  assert.equal(request.headers.authorization, "Bearer user_test");
  assert.equal(request.headers["x-command-code-version"], COMMANDCODE_CLI_VERSION);
  assert.equal(request.headers["x-cli-environment"], "production");
  // The thread is a UUID: the endpoint refuses the request without one.
  assert.match(request.body.threadId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(request.body.params?.model, "stealth/pixel-canary");
  assert.equal(request.body.params?.system, "the system prompt");
  assert.deepEqual(request.body.params?.messages, [{ role: "user", content: "the question" }]);
  assert.equal(request.body.params?.stream, true);
});

test("the answer is read out of the event stream, and reasoning kept out of it", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [
      {
        events: [
          { type: "reasoning-start" },
          { type: "reasoning-delta", text: "the contract asks for " },
          { type: "reasoning-delta", text: "a square" },
          { type: "reasoning-end" },
          { type: "text-start" },
          { type: "text-delta", text: "\t.globl\tsquare\n" },
          { type: "text-delta", text: "square:\n\tmulsd\t%xmm0, %xmm0\n\tret\n" },
          { type: "text-end" },
        ],
      },
    ],
  });

  const result = await generateText({ model: modelAt(endpoint.url), prompt: "write it" });

  // Thinking is the model's own account of the answer, and the answer is what
  // the compiler assembles: one dropped into the other is assembly that was
  // never written.
  assert.equal(result.text, SQUARE_ASSEMBLY);
  assert.match(result.reasoning.filter((part) => part.type === "reasoning").map((part) => part.text).join(""), /a square/);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 4);
});

test("an answer framed as server sent events is read the same", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [{ asEvents: true, events: [{ type: "text-delta", text: "answer" }] }],
  });

  const result = await generateText({ model: modelAt(endpoint.url), prompt: "write it" });
  assert.equal(result.text, "answer");
});

test("how the endpoint stopped is reported in the compiler's own words", async (t) => {
  const endpoint = await generateEndpoint(t, {
    finishReason: "max_tokens",
    answers: [{ events: [{ type: "text-delta", text: "half an implementation" }] }],
  });

  const result = await generateText({ model: modelAt(endpoint.url), prompt: "write it" });
  // The compiler asks again for an answer cut off at the limit rather than
  // assembling half of one, and it decides that on this word.
  assert.equal(result.finishReason, "length");
});

test("a refused request fails with what the endpoint said", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [
      {
        events: [],
        refusal: { status: 401, body: { success: false, error: { code: "UNAUTHORIZED", message: "Invalid 'Authorization' header or token." } } },
      },
    ],
  });

  await assert.rejects(
    () => generateText({ model: modelAt(endpoint.url), prompt: "write it" }),
    /Invalid 'Authorization' header or token\./,
  );
});

test("a failure part way through an answer is that failure, not an empty answer", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [
      {
        events: [
          { type: "text-delta", text: "half an implementation" },
          { type: "error", error: { message: "the upstream provider went away", statusCode: 503 } },
        ],
      },
    ],
  });

  await assert.rejects(
    () => generateText({ model: modelAt(endpoint.url), prompt: "write it" }),
    /the upstream provider went away/,
  );
});

test("an answer that stops without saying why is reported as cut off", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [{ truncated: true, events: [{ type: "text-delta", text: "half an implementation" }] }],
  });

  await assert.rejects(
    () => generateText({ model: modelAt(endpoint.url), prompt: "write it" }),
    /ended without a finish event/,
  );
});

test("a part of the prompt this endpoint cannot take is reported, not dropped silently", async (t) => {
  const endpoint = await generateEndpoint(t, { answers: [{ events: [{ type: "text-delta", text: "answer" }] }] });

  const warnings = await generateText({
    model: modelAt(endpoint.url),
    prompt: "write it",
    tools: {
      write_file: { description: "writes a file", inputSchema: z.object({ path: z.string() }) },
    },
  }).then((result) => result.warnings);

  assert.ok(
    (warnings ?? []).some((warning) => warning.type === "unsupported"),
    `no unsupported warning in: ${JSON.stringify(warnings)}`,
  );
  assert.equal(endpoint.requests[0]?.body.params?.messages?.[0]?.content, "write it");
});

test("a streamed answer reads the same as one asked for whole", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [
      {
        events: [
          { type: "reasoning-delta", text: "thinking" },
          { type: "text-delta", text: "the answer" },
        ],
      },
    ],
  });

  const result = await streamText({ model: modelAt(endpoint.url), prompt: "write it" });
  assert.equal(await result.text, "the answer");
  assert.equal(await result.reasoningText, "thinking");
  assert.equal(await result.finishReason, "stop");
});

/** A project pointed at a stand-in endpoint, built the way a project is. */
async function projectUsing(t: TestContext, endpoint: GenerateEndpoint): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "blaze-commandcode-"));
  const input: SourceInput = {
    language: "typescript",
    source: SQUARE,
    entry: "square",
    model: { provider: "commandcode", model: "stealth/pixel-canary" },
    // The answer this build replays is assembly.
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  };
  await writeProject(join(directory, "input.toml"), input);
  const previous = { key: process.env.COMMANDCODE_API_KEY, url: process.env.COMMANDCODE_BASE_URL };
  process.env.COMMANDCODE_API_KEY = "user_test";
  process.env.COMMANDCODE_BASE_URL = endpoint.url;
  t.after(() => {
    for (const [name, value] of [
      ["COMMANDCODE_API_KEY", previous.key],
      ["COMMANDCODE_BASE_URL", previous.url],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return directory;
}

test("a project built on CommandCode produces the machine it asked for", async (t) => {
  const endpoint = await generateEndpoint(t, {
    answers: [
      {
        events: [
          { type: "reasoning-delta", text: "the contract asks for a square" },
          { type: "text-delta", text: "```asm\n" },
          { type: "text-delta", text: SQUARE_ASSEMBLY },
          { type: "text-delta", text: "```\n" },
        ],
      },
    ],
  });
  const directory = await projectUsing(t, endpoint);

  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.build.model, "commandcode/stealth/pixel-canary");
  assert.equal(endpoint.requests[0]?.body.params?.system !== undefined, true);
  assert.equal(endpoint.requests[0]?.body.params?.model, "stealth/pixel-canary");
});

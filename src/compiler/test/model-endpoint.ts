/**
 * A stand-in for a chat completions endpoint, so a test can drive the real
 * backend, prompt and all, without a credential.
 *
 * The endpoint and the key come from the environment: a project names its
 * provider, never where it points or how it authenticates.
 */

import { createServer } from "node:http";
import type { TestContext } from "node:test";

export interface ChatEndpoint {
  url: string;
  /** The prompts the endpoint was asked, in arrival order. */
  prompts: string[];
  /** Every request as it arrived: where it was addressed and how it authenticated. */
  requests: RecordedRequest[];
  /** The most requests that were in flight at the same time. */
  peak: () => number;
  /** Resolves once a request has arrived, however it was answered. */
  received: Promise<void>;
}

/**
 * One request as the stand-in was handed it. A provider is more than its base
 * URL: it is the path its wire format is asked at, and the credential and the
 * headers it carries there, so those are what a test of one asserts.
 */
export interface RecordedRequest {
  /** The path and query the request was addressed at, relative to the server. */
  readonly url: string;
  readonly authorization: string | undefined;
  readonly session: string | undefined;
}

export interface ChatEndpointOptions {
  /**
   * Hold every request until this many have arrived, so a test can tell a
   * fan-out from a queue: a serial client never gets the second one in flight.
   */
  until?: number;
  /** Accept the request and never answer it, which is what a model that is still thinking looks like from the outside. */
  silent?: boolean;
  /**
   * Refuse this many requests before answering any of them, with an error the
   * provider SDK does not retry itself, so what the compiler does with a
   * failed request is what the test observes.
   */
  failFirst?: number;
  /**
   * Answers each prompt from the prompt itself rather than by arrival order.
   * A build that generates several functions at once cannot say which function
   * a given request arrived for, so a test of that has to answer by what was
   * asked for.
   */
  answer?: (prompt: string) => string;
  /**
   * The reason the provider reports for stopping, which says whether an
   * answer with nothing in it was cut short, taken or simply never had
   * anything in it. Defaults to the reason providers end a reply with.
   */
  finishReason?: string;
  /**
   * The reason the provider reports for stopping, one per request in arrival
   * order and the last one repeated once they run out, for a test whose first
   * answer ends differently from the second. Falls back to `finishReason`.
   */
  finishReasons?: readonly string[];
  /**
   * The tokens to report for each request, or null to report none at all,
   * which is what a gateway standing between the compiler and the model does.
   * Defaults to a request that cost a token in and a token out.
   */
  usage?: { prompt: number; completion: number; total: number } | null;
}

export async function chatEndpoint(
  t: TestContext,
  answers: readonly string[],
  options: ChatEndpointOptions = {},
): Promise<ChatEndpoint> {
  const prompts: string[] = [];
  const requests: RecordedRequest[] = [];
  const arrived = Promise.withResolvers<void>();
  let served = 0;
  let inFlight = 0;
  let peak = 0;
  let waiting = 0;
  let release: (() => void) | undefined;
  const gate = options.until === undefined ? undefined : new Promise<void>((resolve) => (release = resolve));
  // A fan-out that never arrives is a deadlock; the gate opens on its own so a
  // serial client fails the test instead of hanging the suite.
  const openGate = setTimeout(() => release?.(), 5_000);
  openGate.unref();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: { role: string; content: string }[];
      };
      // A header arrives as one value or as several; the credential and the
      // session are each one value, so the first of them is the one asked for.
      const session = request.headers["x-opencode-session"];
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        session: typeof session === "string" ? session : session?.[0],
      });
      prompts.push(body.messages.map((message) => message.content).join("\n\n"));
      const prompt = prompts[prompts.length - 1];
      const content = options.answer?.(prompt) ?? answers[Math.min(served, answers.length - 1)];
      const reason =
        options.finishReasons?.[Math.min(served, options.finishReasons.length - 1)] ??
        options.finishReason ??
        "stop";
      served += 1;
      waiting += 1;
      arrived.resolve();
      if (options.until !== undefined && waiting >= options.until) release?.();
      if (options.silent === true) return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const answer = () => {
        if (options.failFirst !== undefined && served <= options.failFirst) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "the provider rejected the request", type: "invalid_request" } }));
          return;
        }
        const usage = options.usage === undefined ? { prompt: 1, completion: 1, total: 2 } : options.usage;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "stub",
            object: "chat.completion",
            created: 0,
            model: "stub",
            choices: [{ index: 0, finish_reason: reason, message: { role: "assistant", content } }],
            ...(usage === null
              ? {}
              : { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total } }),
          }),
        );
        inFlight -= 1;
      };
      if (gate === undefined) answer();
      else void gate.then(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const previous = { baseUrl: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY };
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AI_API_KEY = "test-key";
  t.after(() => {
    clearTimeout(openGate);
    server.closeAllConnections();
    server.close();
    for (const [name, value] of [
      ["AI_BASE_URL", previous.baseUrl],
      ["AI_API_KEY", previous.apiKey],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return { url: `http://127.0.0.1:${port}/v1`, prompts, requests, peak: () => peak, received: arrived.promise };
}

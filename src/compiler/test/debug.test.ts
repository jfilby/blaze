import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import type { SourceInput } from "../core/types.ts";

/**
 * A stand-in for a chat completions endpoint. It answers with whatever the
 * caller queued, so a test can drive the real backend, prompt and all, without
 * a credential.
 */
async function chatEndpoint(
  t: TestContext,
  answers: string[],
  options: { until?: number } = {},
): Promise<{ url: string; prompts: string[]; peak: () => number }> {
  const prompts: string[] = [];
  let served = 0;
  // Requests are held until `until` of them have arrived, so a test can tell a
  // fan-out from a queue: a serial client never gets the second one in flight.
  let inFlight = 0;
  let peak = 0;
  let arrived = 0;
  let release: (() => void) | undefined;
  const gate = options.until === undefined ? undefined : new Promise<void>((resolve) => (release = resolve));
  const openGate = setTimeout(() => release?.(), 5_000);
  openGate.unref();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: { role: string; content: string }[];
      };
      prompts.push(body.messages.map((message) => message.content).join("\n\n"));
      const content = answers[Math.min(served, answers.length - 1)];
      served += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      arrived += 1;
      if (options.until !== undefined && arrived >= options.until) release?.();
      const answer = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "stub",
            object: "chat.completion",
            created: 0,
            model: "stub",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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

  return { url: `http://127.0.0.1:${port}/v1`, prompts, peak: () => peak };
}

const SQUARE: SourceInput = {
  language: "typescript",
  source: "export function square(x: number): number {\n  return x * x;\n}\n",
  entry: "square",
  model: { provider: "openai-compatible", model: "stub" },
  generation: { maxCandidates: 1, maxAttempts: 2 },
  optimize: { primary: "size" },
};

/** x arrives in xmm0 as a double; the contract asks for x * x. */
const SQUARE_ASSEMBLY = ["\t.globl\tsquare", "square:", "\tmulsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

/** Assembles and links cleanly, but computes x + x, so verification rejects it. */
const WRONG_SQUARE_ASSEMBLY = ["\t.globl\tsquare", "square:", "\taddsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

async function project(t: TestContext, answers: string[]): Promise<string> {
  await chatEndpoint(t, answers);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeFile(join(directory, "blaze.json"), JSON.stringify(SQUARE), "utf8");
  return directory;
}

/** A project that produces `candidates` implementations, `concurrency` at a time. */
async function fanOutProject(
  t: TestContext,
  answers: string[],
  input: Partial<SourceInput>,
  until?: number,
): Promise<{ directory: string; peak: () => number }> {
  const endpoint = await chatEndpoint(t, answers, until === undefined ? {} : { until });
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  const project: SourceInput = {
    ...SQUARE,
    generation: { maxCandidates: 1, maxAttempts: 1 },
    ...input,
  };
  await writeFile(join(directory, "blaze.json"), JSON.stringify(project), "utf8");
  return { directory, peak: endpoint.peak };
}

test("candidates are generated at the same time when concurrency allows it", async (t) => {
  // The endpoint answers only once three requests are in flight, so a client
  // that generated candidates one at a time could never get past the first.
  // The guard timeout is a deadlock escape for that case, not a synchronisation
  // point: it can only turn a real fan-out into a failure, never the reverse.
  const { directory, peak } = await fanOutProject(
    t,
    [SQUARE_ASSEMBLY],
    { generation: { maxCandidates: 3, maxAttempts: 1, concurrency: 3 } },
    3,
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(peak(), 3, "three candidates should have been in flight together");
});

test("concurrency of one generates candidates one at a time", async (t) => {
  const { directory, peak } = await fanOutProject(
    t,
    [SQUARE_ASSEMBLY],
    { generation: { maxCandidates: 3, maxAttempts: 1, concurrency: 1 } },
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(peak(), 1, "a candidate must be answered before the next is asked for");
  // One record per candidate, whatever order they were produced in.
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.id), ["c1", "c2", "c3"]);
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.candidate), [1, 2, 3]);
});

test("without --debug the prompts stay out of the way", async (t) => {
  const endpoint = await chatEndpoint(t, [SQUARE_ASSEMBLY]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeFile(join(directory, "blaze.json"), JSON.stringify(SQUARE), "utf8");

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", endpoint.url);
  assert.equal(written.join(""), "", "a quiet build writes no diagnostics");
});

test("--debug prints the system and user prompt of every attempt", async (t) => {
  const directory = await project(t, [WRONG_SQUARE_ASSEMBLY, SQUARE_ASSEMBLY]);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false, debug: true }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", "the repair should succeed");
  assert.equal(outcome.build.selectedCandidates?.square, "c2");

  const debug = written.join("");
  // One dump per attempt: the rejected one and its repair.
  assert.equal(debug.match(/-- prompt 1\.1: system --/g)?.length, 1);
  assert.equal(debug.match(/-- prompt 1\.2: system --/g)?.length, 1);
  assert.match(debug, /You are a native code generation backend/);
  assert.match(debug, /"name": "square"/);
  assert.match(debug, /result == \(x \* x\)/);
  assert.match(debug, /"arch": "x86_64"/);
  assert.match(debug, /OUTPUT LANGUAGE/);
  assert.match(debug, /Write GNU assembler \(GAS\) AT&T syntax for x86-64/);

  // Only the repair names a rejected candidate; the first attempt is generated
  // from the contract alone and has nothing to repair.
  assert.equal(debug.match(/CANDIDATE 1 WAS REJECTED/g)?.length, 1);

  // The repair is handed the assembly it is fixing, and why it was rejected.
  assert.match(debug, /THE OUTPUT BEING REPAIRED/);
  assert.match(debug, /addsd\t%xmm0, %xmm0/, "the repair prompt carries the rejected assembly");
  assert.match(debug, /This is repair attempt 2/);
  assert.match(debug, /verify failed: \d+ of \d+ test vectors did not match the contract/);
  assert.match(debug, /\[attempt 1] verify failed:/, "the diagnostic is attributed to the attempt that earned it");
  assert.match(debug, /expected [\d.e+-]+, got [\d.e+-]+ \(/);
});

test("the prompt reaches the model as the contract and the instructions", async (t) => {
  const endpoint = await chatEndpoint(t, [SQUARE_ASSEMBLY]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeFile(join(directory, "blaze.json"), JSON.stringify(SQUARE), "utf8");

  await runBuild("blaze.json", { cwd: directory, reuse: false, debug: true }, { stage: () => {} }, "build");

  assert.equal(endpoint.prompts.length, 1);
  const sent = endpoint.prompts[0];
  assert.match(sent, /native code generation backend/);
  assert.match(sent, /"name": "square"/);
  assert.match(sent, /"arch": "x86_64"/);
});

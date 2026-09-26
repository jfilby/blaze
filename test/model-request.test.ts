import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, inspectProject } from "../src/compiler/compiler.ts";
import type { SourceInput } from "../src/compiler/core/types.ts";

const quiet = { stage: () => {} };
const SOURCE = "export function square(x: number): number {\n  return x * x;\n}\n";

interface SilentModel {
  directory: string;
  /** Resolves once a request has arrived and gone unanswered. */
  received: Promise<void>;
}

/**
 * A project pointed at a model that accepts the request and never answers,
 * which is what a model that is still thinking looks like from the outside.
 *
 * The endpoint and the key come from the environment: a project names its
 * provider, never where it points or how it authenticates.
 */
async function projectWaitingOn(t: TestContext, generation: SourceInput["generation"]): Promise<SilentModel> {
  const requestArrived = Promise.withResolvers<void>();
  const server = createServer(() => requestArrived.resolve());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const previous = { baseUrl: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY };
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AI_API_KEY = "test-key";
  t.after(() => {
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

  const directory = await mkdtemp(join(tmpdir(), "blaze-model-"));
  const input: SourceInput = {
    language: "typescript",
    source: SOURCE,
    entry: "square",
    model: { provider: "openai-compatible", model: "silent" },
    generation,
  };
  await writeFile(join(directory, "input.json"), JSON.stringify(input), "utf8");
  return { directory, received: requestArrived.promise };
}

test("a model that has not answered is waited for, not given up on", async (t) => {
  const { directory, received } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1 });

  let settled = false;
  const building = runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build").then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  // The request is open and the model has said nothing. There is no budget in
  // this project, so the build must still be waiting on it.
  await received;
  assert.equal(settled, false, "the build should still be waiting for the model");
  void building;
});

// The tests below do wait on the clock, on purpose: the subject is a wall clock
// budget, so the only way to observe it is for it to elapse. Each one waits for
// the shortest budget the assertion needs.
test("a project that sets a budget gives up when the model overruns it", async (t) => {
  const { directory } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1, timeoutSeconds: 1 });

  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) => {
      const diagnostic =
        error instanceof Error ? `${error.message}\n${(error as { detail?: string }).detail ?? ""}` : String(error);
      assert.match(diagnostic, /did not answer within 1s/);
      assert.match(diagnostic, /remove generation\.timeoutSeconds/);
      return true;
    },
  );
});

test("the build record keeps the model that was asked", async (t) => {
  const { directory } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1, timeoutSeconds: 1 });
  await assert.rejects(() => runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build"));

  const build = await inspectProject("input", directory);
  assert.equal(build.status, "failed");
  assert.equal(build.model, "openai-compatible/silent");
  assert.equal(build.error?.category, "AiGenerationError");
});

test("the compiler says which model it is waiting for", async (t) => {
  const { directory } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1, timeoutSeconds: 1 });
  const lines: string[] = [];
  await assert.rejects(() =>
    runBuild(
      "input.json",
      { cwd: directory, reuse: false },
      { stage: (_stage, _status, message) => lines.push(message) },
      "build",
    ),
  );

  assert.ok(lines.includes("Model: openai-compatible/silent"), `no model line in: ${lines.join(" | ")}`);
  assert.ok(
    lines.some((line) => line === "Generating assembly: attempt 1 of 1, waiting for openai-compatible/silent"),
    `no generating line in: ${lines.join(" | ")}`,
  );
});

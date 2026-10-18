/**
 * End-to-end HTTP serving with `--runtime facil`.
 *
 * Builds a program that calls `http.serve(port)`, runs the binary as a server,
 * curls `GET /`, and checks the answer. The server never returns
 * (`blaze_http_server_run` blocks), so each test starts it in the background
 * and stops it when the request is done.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { scratch } from "./scratch.ts";
import { run } from "../core/process.ts";
import { writeProject } from "./project.ts";

const QUIET = { stage: () => {} };

/** A program that serves "Hello, World" on every route. */
const HTTP_SOURCE = "const port = 18080;\nhttp.serve(port);\n";

const PORT = 18080;

async function buildHttpBinary(backend: "c" | "machine"): Promise<string> {
  const directory = await scratch(`blaze-http-${backend}-`);
  await writeFile(join(directory, "main.ts"), HTTP_SOURCE, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend,
    mode: "debug",
    runtime: "facil",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", `${backend} build succeeded`);
  assert.ok(outcome.outputPath !== null, `${backend} build delivered a binary`);
  return outcome.outputPath as string;
}

/** Start the server binary in the background and wait until it answers. */
async function startServer(binary: string): Promise<import("node:child_process").ChildProcess> {
  const server = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  let resolved = false;
  const ready = new Promise<void>((resolve) => {
    server.stdout?.on("data", () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
  });
  // Give the event loop a moment to bind the port, whether or not it prints.
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
  return server;
}

/** Curl the server, retrying while it is starting up. */
async function curlHello(): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = run("curl", ["-s", "--max-time", "2", `http://localhost:${PORT}/`], { timeoutMs: 5_000 });
    if (result.code === 0 && result.stdout.length > 0) return result.stdout;
    lastError = result.stderr.trim();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new assert.AssertionError({ message: `server did not answer: ${lastError}` });
}

test("C backend serves HTTP with --runtime facil", async () => {
  const binary = await buildHttpBinary("c");
  const server = await startServer(binary);
  try {
    const body = await curlHello();
    assert.equal(body, "Hello, World\n", "C backend answered GET / with Hello, World");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend serves HTTP with --runtime facil", async () => {
  const binary = await buildHttpBinary("machine");
  const server = await startServer(binary);
  try {
    const body = await curlHello();
    assert.equal(body, "Hello, World\n", "machine backend answered GET / with Hello, World");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

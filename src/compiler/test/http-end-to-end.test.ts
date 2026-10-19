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

async function buildHttpBinary(backend: "c" | "machine", source: string): Promise<string> {
  const directory = await scratch(`blaze-http-${backend}-`);
  await writeFile(join(directory, "main.ts"), source, "utf8");
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

/** Curl a port, retrying while the server is starting up. */
async function curlPort(port: number): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = run("curl", ["-s", "--max-time", "2", `http://localhost:${port}/`], { timeoutMs: 5_000 });
    if (result.code === 0 && result.stdout.length > 0) return result.stdout;
    lastError = result.stderr.trim();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new assert.AssertionError({ message: `server on port ${port} did not answer: ${lastError}` });
}

test("C backend serves HTTP with --runtime facil", async () => {
  const binary = await buildHttpBinary("c", HTTP_SOURCE);
  const server = await startServer(binary);
  try {
    const body = await curlPort(PORT);
    assert.equal(body, "Hello, World\n", "C backend answered GET / with Hello, World");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend serves HTTP with --runtime facil", async () => {
  const binary = await buildHttpBinary("machine", HTTP_SOURCE);
  const server = await startServer(binary);
  try {
    const body = await curlPort(PORT);
    assert.equal(body, "Hello, World\n", "machine backend answered GET / with Hello, World");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A program that uses http.createServer + server.listen with a custom response. */
function createServerSource(port: number): string {
  return `const port = ${port};\n` +
    `const server = http.createServer((req, res) => { res.writeHead(200); res.end("custom response\\n"); });\n` +
    `server.listen(port, "127.0.0.1", () => {});\n`;
}

test("C backend serves custom response with http.createServer and server.listen", async () => {
  const port = 18081;
  const binary = await buildHttpBinary("c", createServerSource(port));
  const server = await startServer(binary);
  try {
    const body = await curlPort(port);
    assert.equal(body, "custom response\n", "C backend answered with custom response from createServer");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend serves custom response with http.createServer and server.listen", async () => {
  const port = 18082;
  const binary = await buildHttpBinary("machine", createServerSource(port));
  const server = await startServer(binary);
  try {
    const body = await curlPort(port);
    assert.equal(body, "custom response\n", "machine backend answered with custom response from createServer");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A program that reads the request body with req.text. */
function echoServerSource(port: number): string {
  return `const port = ${port};\n` +
    `const server = http.createServer((req, res) => { const body = req.text(); res.writeHead(200); res.end(body); });\n` +
    `server.listen(port, "127.0.0.1", () => {});\n`;
}

test("C backend echoes request body via req.text", async () => {
  const port = 18083;
  const binary = await buildHttpBinary("c", echoServerSource(port));
  const server = await startServer(binary);
  try {
    // POST a body and check it is echoed back.
    let result = run("curl", ["-s", "--max-time", "2", "-X", "POST", "-d", "echo-me", `http://localhost:${port}/`], { timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 20 && !(result.code === 0 && result.stdout.length > 0); attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      result = run("curl", ["-s", "--max-time", "2", "-X", "POST", "-d", "echo-me", `http://localhost:${port}/`], { timeoutMs: 5_000 });
    }
    assert.equal(result.stdout, "echo-me", "C backend echoed the POST body");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend echoes request body via req.text", async () => {
  const port = 18084;
  const binary = await buildHttpBinary("machine", echoServerSource(port));
  const server = await startServer(binary);
  try {
    let result = run("curl", ["-s", "--max-time", "2", "-X", "POST", "-d", "echo-me", `http://localhost:${port}/`], { timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 20 && !(result.code === 0 && result.stdout.length > 0); attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      result = run("curl", ["-s", "--max-time", "2", "-X", "POST", "-d", "echo-me", `http://localhost:${port}/`], { timeoutMs: 5_000 });
    }
    assert.equal(result.stdout, "echo-me", "machine backend echoed the POST body");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

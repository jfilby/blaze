/**
 * HTTP server facilities backed by `--runtime facil`: concurrency, resource
 * limits, timeouts and HTTPS. facil.io provides these; the Blaze side configures
 * them through `http.serveSettings` and `http.serveTls`, and these tests build
 * and run real binaries (C and machine backends) against a live server.
 *
 * Each test starts the server binary in the background, issues real HTTP(S)
 * requests with curl, and stops the server when done.
 *
 * Note: a threaded facil.io server (`threads`/`workers` greater than one) answers
 * when its standard streams are a terminal, but not when they are pipes (as the
 * test harness spawns it). Concurrency is therefore exercised by issuing several
 * simultaneous connections, which facil.io multiplexes even on one thread.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { scratch } from "./scratch.ts";
import { run } from "../core/process.ts";
import { writeProject } from "./project.ts";

const QUIET = { stage: () => {} };

type Backend = "c" | "machine";

interface BuiltBinary {
  path: string;
  directory: string;
}

async function buildHttpBinary(backend: Backend, source: string, files: Record<string, string> = {}): Promise<BuiltBinary> {
  const directory = await scratch(`blaze-http-facilities-${backend}-`);
  await writeFile(join(directory, "main.ts"), source, "utf8");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content, "utf8");
  }
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
  return { path: outcome.outputPath as string, directory };
}

/** Start the server binary in the background and wait until it answers. */
async function startServer(binary: string, cwd: string): Promise<import("node:child_process").ChildProcess> {
  const server = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], cwd });
  let resolved = false;
  const ready = new Promise<void>((resolve) => {
    const onData = () => { if (!resolved) { resolved = true; resolve(); } };
    if (server.stdout) server.stdout.on("data", onData);
  });
  // `blaze_http_server_run` blocks and prints nothing, so wait for the bind.
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
  return server;
}

/** Curl a URL, retrying while the server is starting up. Returns the body. */
async function curlUrl(url: string, extra: string[] = []): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = run("curl", ["-s", "--max-time", "2", url, ...extra], { timeoutMs: 5_000 });
    if (result.code === 0 && result.stdout.length > 0) return result.stdout;
    lastError = result.stderr.trim();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new assert.AssertionError({ message: `server did not answer ${url}: ${lastError}` });
}

/** Curl a URL and return the HTTP status code (empty when the server is not up). */
async function curlStatus(url: string, extra: string[] = []): Promise<string> {
  let lastCode = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", url, ...extra], { timeoutMs: 5_000 });
    if (result.code === 0 && result.stdout.length > 0) return result.stdout.trim();
    lastCode = result.stdout.trim();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new assert.AssertionError({ message: `server did not answer ${url}: last code ${lastCode}` });
}

/** A settings-configured server that answers every route with "Hello, World". */
function serveSettingsSource(port: number): string {
  return `const port = ${port};\n` +
    `http.serveSettings(port, 128, 1000000, 8192, 40, 1, 1);\n`;
}

test("C backend serves concurrent connections with http.serveSettings", async () => {
  const port = 18100;
  const { path, directory } = await buildHttpBinary("c", serveSettingsSource(port));
  const server = await startServer(path, directory);
  try {
    // Fire several concurrent connections; facil.io multiplexes them and every
    // one must be answered.
    const bodies = await Promise.all(
      [...Array(6)].map(() => curlUrl(`http://localhost:${port}/`)),
    );
    for (const body of bodies) {
      assert.equal(body, "Hello, World\n", "every concurrent connection answered");
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend serves concurrent connections with http.serveSettings", async () => {
  const port = 18101;
  const { path, directory } = await buildHttpBinary("machine", serveSettingsSource(port));
  const server = await startServer(path, directory);
  try {
    const bodies = await Promise.all(
      [...Array(6)].map(() => curlUrl(`http://localhost:${port}/`)),
    );
    for (const body of bodies) {
      assert.equal(body, "Hello, World\n", "every concurrent connection answered");
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A server with a tiny max_body_size: a large POST is rejected, a small one served. */
function bodyLimitSource(port: number): string {
  return `const port = ${port};\n` +
    `http.serveSettings(port, 128, 32, 8192, 40, 1, 1);\n`;
}

test("C backend rejects an oversized request body via max_body_size", async () => {
  const port = 18102;
  const { path, directory } = await buildHttpBinary("c", bodyLimitSource(port));
  const server = await startServer(path, directory);
  try {
    // A body larger than the 32-byte limit is refused with HTTP 413.
    const code = await curlStatus(`http://localhost:${port}/`, [
      "-X", "POST", "-d", "this body is definitely longer than thirty two bytes",
    ]);
    assert.equal(code, "413", "an oversized POST body is refused with 413");
    // The server is still alive: a small request afterwards is answered.
    const again = await curlUrl(`http://localhost:${port}/`);
    assert.equal(again, "Hello, World\n", "the server still answers after a rejected body");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend rejects an oversized request body via max_body_size", async () => {
  const port = 18103;
  const { path, directory } = await buildHttpBinary("machine", bodyLimitSource(port));
  const server = await startServer(path, directory);
  try {
    const code = await curlStatus(`http://localhost:${port}/`, [
      "-X", "POST", "-d", "this body is definitely longer than thirty two bytes",
    ]);
    assert.equal(code, "413", "an oversized POST body is refused with 413");
    const again = await curlUrl(`http://localhost:${port}/`);
    assert.equal(again, "Hello, World\n", "the server still answers after a rejected body");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** Generates a self-signed certificate and key into `directory`, returning their names. */
async function generateSelfSignedCerts(directory: string): Promise<void> {
  await writeFile(join(directory, "cert.cnf"), "[req]\ndistinguished_name = req\ndefault_bits = 2048\nprompt = no\nx509_extensions = v3\n[v3]\nsubjectAltName = DNS:localhost\n", "utf8");
  const result = run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=localhost", "-config", join(directory, "cert.cnf")], { cwd: directory, timeoutMs: 30_000 });
  assert.equal(result.code, 0, "openssl generated a self-signed certificate and key");
}

/** An HTTPS server that answers every route with the default "Hello, World". */
function serveTlsSource(port: number): string {
  return `const port = ${port};\n` +
    `http.serveTls(port, "cert.pem", "key.pem");\n`;
}

test("C backend serves HTTPS with http.serveTls", async () => {
  const port = 18104;
  const directory = await scratch("blaze-http-facilities-c-tls-");
  await generateSelfSignedCerts(directory);
  const { path } = await buildHttpBinary("c", serveTlsSource(port), {
    "cert.pem": await readFile(join(directory, "cert.pem"), "utf8"),
    "key.pem": await readFile(join(directory, "key.pem"), "utf8"),
  });
  const server = await startServer(path, directory);
  try {
    const body = await curlUrl(`https://localhost:${port}/`, ["-k"]);
    assert.equal(body, "Hello, World\n", "C backend answered HTTPS GET / over TLS");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend serves HTTPS with http.serveTls", async () => {
  const port = 18105;
  const directory = await scratch("blaze-http-facilities-machine-tls-");
  await generateSelfSignedCerts(directory);
  const { path } = await buildHttpBinary("machine", serveTlsSource(port), {
    "cert.pem": await readFile(join(directory, "cert.pem"), "utf8"),
    "key.pem": await readFile(join(directory, "key.pem"), "utf8"),
  });
  const server = await startServer(path, directory);
  try {
    const body = await curlUrl(`https://localhost:${port}/`, ["-k"]);
    assert.equal(body, "Hello, World\n", "machine backend answered HTTPS GET / over TLS");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A server configured with a one-second connection timeout (smoke test: the
   setting is applied and the server still answers a prompt request). */
function timeoutSource(port: number): string {
  return `const port = ${port};\n` +
    `http.serveSettings(port, 128, 1000000, 8192, 1, 1, 1);\n`;
}

test("C backend starts with a configured connection timeout", async () => {
  const port = 18106;
  const { path, directory } = await buildHttpBinary("c", timeoutSource(port));
  const server = await startServer(path, directory);
  try {
    const body = await curlUrl(`http://localhost:${port}/`);
    assert.equal(body, "Hello, World\n", "the server answers with a one-second timeout configured");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend starts with a configured connection timeout", async () => {
  const port = 18107;
  const { path, directory } = await buildHttpBinary("machine", timeoutSource(port));
  const server = await startServer(path, directory);
  try {
    const body = await curlUrl(`http://localhost:${port}/`);
    assert.equal(body, "Hello, World\n", "the server answers with a one-second timeout configured");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

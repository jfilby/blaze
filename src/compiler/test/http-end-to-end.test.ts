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
import { generateProgramDriver } from "../toolchain/driver.ts";
import { phaseOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
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

/** Curl a port, retrying while the server is starting up. The authority is
 *  the host part of the URL, written as a URL writes it: an IPv6 address is
 *  between brackets, as in "[::1]". */
async function curlPort(port: number, authority = "localhost"): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = run("curl", ["-s", "--max-time", "2", `http://${authority}:${port}/`], { timeoutMs: 5_000 });
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
function createServerSource(port: number, host = "127.0.0.1"): string {
  return `const port = ${port};\n` +
    `const server = http.createServer((req, res) => { res.writeHead(200); res.end("custom response\\n"); });\n` +
    `server.listen(port, "${host}", () => {});\n`;
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

test("C backend serves a server bound to an IPv6 address", async () => {
  const port = 18111;
  const binary = await buildHttpBinary("c", createServerSource(port, "::1"));
  const server = await startServer(binary);
  try {
    const body = await curlPort(port, "[::1]");
    assert.equal(body, "custom response\n", "C backend answered an IPv6 request");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend serves a server bound to an IPv6 address", async () => {
  const port = 18112;
  const binary = await buildHttpBinary("machine", createServerSource(port, "::1"));
  const server = await startServer(binary);
  try {
    const body = await curlPort(port, "[::1]");
    assert.equal(body, "custom response\n", "machine backend answered an IPv6 request");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("a server that names no address serves IPv4 and IPv6 alike", async () => {
  const port = 18113;
  const binary = await buildHttpBinary("c", `const port = ${port};\nhttp.serve(port);\n`);
  const server = await startServer(binary);
  try {
    assert.equal(await curlPort(port, "127.0.0.1"), "Hello, World\n", "the server answered over IPv4");
    assert.equal(await curlPort(port, "[::1]"), "Hello, World\n", "the server answered over IPv6");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A program that asks a server at an IPv6 address, written as a URL writes it. */
function ipv6ClientSource(port: number): string {
  return `const port = ${port};\n` +
    `const req = http.request(\`http://[::1]:\${port}/\`, { method: "GET" }, (res) => {\n` +
    `  var content = "";\n` +
    `  res.on("data", (chunk) => { content += chunk; });\n` +
    `  res.on("end", () => { console.log(content); });\n` +
    `});\n` +
    `req.end();\n`;
}

test("C backend asks a server at an IPv6 address", async () => {
  const port = 18114;
  const server = await buildHttpBinary("c", createServerSource(port, "::1"));
  const running = await startServer(server);
  try {
    const client = await buildHttpBinary("c", ipv6ClientSource(port));
    const answered = run(client, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.stdout.trim(), "custom response", "the client read the response over IPv6");
  } finally {
    running.kill();
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

function resolved(source: string) {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  if (phase.body === undefined) throw new Error("no program body");
  return resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
}

test("a response that ends with no body answers with the empty text", () => {
  // `res.end()` is the empty response a 204 is answered with. It used to take
  // exactly two arguments, so the form Node programs are written with was
  // refused for the body it did not write.
  const source = `const server = http.createServer((req, res) => { res.writeHead(204); res.end(); });\n` +
    `server.listen(18096, "127.0.0.1", () => {});\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(written, /blaze_http_resp_body_text = \(const char \*\) ""/, "the body is the empty text");
  assert.match(written, /blaze_http_resp_complete/, "the response is completed");
});

test("server.listen starts the event loop in the background and server.close stops the held server", () => {
  const source = `const port = 18090;\n` +
    `const server = http.createServer((req, res) => { res.writeHead(200); res.end("closed\n"); });\n` +
    `server.listen(port, "127.0.0.1", () => { server.close(); });\n` +
    `console.log("done");\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(written, /blaze_http_server_start_background/, "server.listen starts the event loop on a background thread");
  assert.match(written, /blaze_http_server_join/, "server.listen joins the background thread so the callback can stop it");
  assert.match(written, /blaze_http_server_stop\(blaze_http_server_held\(\)\)/, "server.close stops the server the adapter holds");
});

test("server.listen hands the host it was given to the runtime", () => {
  const source = `const port = 18115;\n` +
    `const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok\\n"); });\n` +
    `server.listen(port, "::1", () => {});\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(
    written,
    /blaze_http_server_new\("::1", \(uint16_t\)port\)/,
    "the host of server.listen is the address the server binds",
  );
});

test("http.request lowers to blaze_http_client_request", () => {
  const source = `const body = http.request("http://127.0.0.1:8080/", "GET", "", "");\nconsole.log(body);\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(written, /blaze_http_client_request/, "http.request lowers to the client runtime call");
});

test("fetch lowers to blaze_http_client_request", () => {
  const source = `const body = fetch("http://127.0.0.1:8080/", "GET", "", "");\nconsole.log(body);\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(written, /blaze_http_client_request/, "fetch lowers to the client runtime call");
});

/** A program that makes a request in the Node.js callback form. */
function clientRequestSource(port: number): string {
  return `const port = ${port};\n` +
    `const req = http.request(\`http://127.0.0.1:\${port}/\`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {\n` +
    `  var content = "";\n` +
    `  res.on("data", (chunk) => { content += chunk; });\n` +
    `  res.on("end", () => { console.log(content); });\n` +
    `});\n` +
    `req.write("hello");\n` +
    `req.end();\n`;
}

test("http.request in the callback form opens a buffered request", () => {
  const written = generateProgramDriver(resolved(clientRequestSource(18085)), true);
  assert.match(written, /blaze_http_client_open/, "the callback form opens a buffered request");
  assert.match(written, /blaze_http_client_method/, "the method the options name is written on the request");
  assert.match(written, /blaze_http_client_header/, "the headers the options name are written on the request");
  assert.match(written, /blaze_http_client_write/, "req.write buffers the body of the request");
  assert.match(written, /blaze_http_client_end/, "req.end sends the request");
});

/** A client whose callback captured two values of the scope it was written in. */
function capturingClientSource(port: number): string {
  return `const port = ${port};\n` +
    `let prefix = "got: ";\n` +
    `let suffix = "!";\n` +
    `const req = http.request(\`http://127.0.0.1:\${port}/\`, { method: "GET" }, (res) => {\n` +
    `  console.log(prefix + suffix);\n` +
    `});\n` +
    `req.end();\n`;
}

test("every value a client callback captured is carried to the callback", () => {
  // The adapter is handed the handler of a request and the values the handler
  // captured. It had room for one of them, so a callback that captured two was
  // given the first and read the second out of nothing.
  const written = generateProgramDriver(resolved(capturingClientSource(18088)), true);
  assert.match(
    written,
    /blaze_capture_t blaze_http_caps\[2\] = \{ \(blaze_capture_t\)\{ \.pointer = \(void \*\)\(uintptr_t\)\(\w+\), \.number = 0\.0 \}, \(blaze_capture_t\)\{ \.pointer = \(void \*\)\(uintptr_t\)\(\w+\), \.number = 0\.0 \} \};/,
    "the values the callback captured are written out as a bundle of two",
  );
  assert.match(
    written,
    /blaze_http_client_watch\(blaze_http_req, 0, \(void \*\)__arrow_trampoline_\d+, blaze_http_caps, sizeof\(blaze_http_caps\)\);/,
    "the request carries the whole bundle of them to the adapter",
  );
  assert.match(
    written,
    /__arrow_trampoline_\d+\(void \*p0, void \*p1\) \{\n {2}__arrow_\d+\([^;]*\(\(blaze_capture_t \*\)p1\)\[0\]\.pointer[^;]*\(\(blaze_capture_t \*\)p1\)\[1\]\.pointer/,
    "the trampoline reads both of them out of the bundle",
  );
});

test("a server whose port is already held does not wait on a thread it never started", async () => {
  // A program that cannot bind its port has no event loop to join. The thread
  // id it would have joined is the zero an unstarted thread is, and joining
  // that is a write through nothing: the second program crashed rather than
  // running its callback and returning. A busy test machine binds the same
  // port twice when two suites run together, which is how it was found.
  const port = 18095;
  const first = await buildHttpBinary("c", createServerSource(port));
  const running = await startServer(first);
  try {
    const second = await buildHttpBinary("c", createServerSource(port));
    const answered = run(second, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("C backend answers a request made by a callback that captured two values", async () => {
  const port = 18092;
  const server = await buildHttpBinary("c", createServerSource(port));
  const running = await startServer(server);
  try {
    const client = await buildHttpBinary("c", capturingClientSource(port));
    const answered = run(client, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.stdout.trim(), "got: !", "the callback read both of the values it captured");
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A client whose callback captured a number that is not a whole number. */
function numberCapturingClientSource(port: number): string {
  return `const port = ${port};\n` +
    `const scale = 1.5;\n` +
    `const req = http.request(\`http://127.0.0.1:\${port}/\`, { method: "GET" }, (res) => {\n` +
    `  console.log(scale);\n` +
    `});\n` +
    `req.end();\n`;
}

test("a number a callback captured is carried to it as the number it is", () => {
  // A capture used to be carried to the callback as a pointer, and a number
  // carried as a pointer is rounded to a whole number on the way: a callback
  // that captured 1.5 was given 1.
  const written = generateProgramDriver(resolved(numberCapturingClientSource(18093)), true);
  assert.match(
    written,
    /blaze_capture_t blaze_http_caps\[1\] = \{ \(blaze_capture_t\)\{ \.pointer = NULL, \.number = \(double\)\(1\.5\) \} \};/,
    "the number is carried as the number it is",
  );
  assert.match(
    written,
    /__arrow_trampoline_\d+\(void \*p0, void \*p1\) \{\n {2}__arrow_\d+\([^;]*\(\(blaze_capture_t \*\)p1\)\[0\]\.number/,
    "the trampoline reads the number out of the bundle",
  );
});

test("C backend answers a request made by a callback that captured a number", async () => {
  const port = 18094;
  const server = await buildHttpBinary("c", createServerSource(port));
  const running = await startServer(server);
  try {
    const client = await buildHttpBinary("c", numberCapturingClientSource(port));
    const answered = run(client, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.stdout.trim(), "1.5", "the callback read the number it captured as it was written");
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("C backend answers a request made in the callback form", async () => {
  const port = 18086;
  const server = await buildHttpBinary("c", createServerSource(port));
  const running = await startServer(server);
  try {
    const client = await buildHttpBinary("c", clientRequestSource(port));
    const answered = run(client, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
    assert.match(answered.stdout, /custom response/, "the client read the response the server sent");
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("machine backend answers a request made in the callback form", async () => {
  const port = 18087;
  const server = await buildHttpBinary("machine", createServerSource(port));
  const running = await startServer(server);
  try {
    const client = await buildHttpBinary("machine", clientRequestSource(port));
    const answered = run(client, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
    assert.match(answered.stdout, /custom response/, "the client read the response the server sent");
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("a request that cannot be made rejects the promise the executor holds", () => {
  const source = `const req = http.request("http://127.0.0.1:1/", { method: "GET" }, (res) => {\n` +
    `  res.on("error", (err) => { console.log("failed"); });\n` +
    `});\n` +
    `req.on("error", (err) => { console.log("no request"); });\n` +
    `req.end();\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(written, /blaze_http_client_watch/, "the error handler is bound to the request");
});

/**
 * A program that answers a request with the value the body carries, written the
 * way the source is written: a handler the program names, a body it reads as it
 * arrives, and a JSON field it reads out of it.
 */
function bodyServerSource(port: number): string {
  return `const port = ${port};\n` +
    `function handler(req, res) {\n` +
    `  var body = "";\n` +
    `  req.on("data", function (chunk) { body += chunk; });\n` +
    `  req.on("end", function () {\n` +
    `    const payload = JSON.parse(body);\n` +
    `    res.writeHead(200);\n` +
    `    res.end(payload.value.toString());\n` +
    `  });\n` +
    `}\n` +
    `const server = http.createServer(handler);\n` +
    `server.listen(port, "localhost", () => {});\n`;
}

/**
 * A program that sends a value to a server and prints what it answers, written
 * the way the source is written: a string the program builds and hands to a
 * function of its own, a promise the function answers, and an await of it.
 */
function bodyClientSource(port: number): string {
  return `const port = ${port};\n` +
    `const api = \`http://localhost:\${port}/\`;\n` +
    `function send(api, value) {\n` +
    `  return new Promise(function (onFulfilled, onRejected) {\n` +
    `    const req = http.request(api, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {\n` +
    `      var content = "";\n` +
    `      res.on("data", (chunk) => { content += chunk; });\n` +
    `      res.on("end", () => { onFulfilled(+content); });\n` +
    `    });\n` +
    `    req.on("error", (err) => { onRejected(err); });\n` +
    `    req.write(JSON.stringify({ value: value }));\n` +
    `    req.end();\n` +
    `  });\n` +
    `}\n` +
    `const answer = await send(api, 42);\n` +
    `console.log(answer);\n`;
}

test("a string is handed to a function of a program and the request it makes is answered", async () => {
  const port = 18091;
  const server = await buildHttpBinary("c", bodyServerSource(port));
  const running = await startServer(server);
  try {
    const client = await buildHttpBinary("c", bodyClientSource(port));
    const answered = run(client, [], { timeoutMs: 30_000 });
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.stdout.trim(), "42", "the client read the value the server answered with");
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("the request a program makes carries the body it wrote", async () => {
  // The body of a request is written after the headers, and the headers end
  // where the length of the body begins: a blank line between them ends the
  // header block, and the server reads the length of the body as the body.
  const source = `const req = http.request("http://127.0.0.1:1/", { method: "POST", headers: { "content-type": "application/json" } }, (res) => {});\n` +
    `req.write("hello");\n` +
    `req.end();\n`;
  const written = generateProgramDriver(resolved(source), true);
  assert.match(written, /blaze_http_client_write/, "the body of the request is written on the request");
  assert.match(written, /blaze_http_client_end/, "the request is sent");
});

test("a build replaces a program that is still running", async () => {
  // Rebuilding while the old binary serves is the usual way round, and the
  // file of a running program cannot be written: the copy a build delivered by
  // was refused by the machine itself, ETXTBSY, text file busy. The delivery
  // is a rename now, so the build replaces the name the running program is
  // held by and leaves the running program running.
  const directory = await scratch("blaze-rebuild-running-");
  await writeFile(join(directory, "main.ts"), HTTP_SOURCE, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend: "c",
    mode: "debug",
    runtime: "facil",
  });
  const first = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(first.build.status, "success");
  const running = await startServer(first.outputPath as string);
  try {
    const second = await runBuild(
      "blaze.toml",
      { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
      QUIET,
      "build",
    );
    assert.equal(second.build.status, "success", "the build replaced the program that was running");
  } finally {
    running.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

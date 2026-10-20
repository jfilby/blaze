/**
 * The HTTP client keeps its connections open between requests.
 *
 * A request that opens a connection pays for a name lookup, a handshake and a
 * teardown, and the next request to the same server does not have to pay for
 * them again. The client keeps the connection open, asks the server to keep
 * it open, and reads the body of an answer where the answer says the body
 * ends rather than where the connection ends.
 *
 * The server here is a plain socket that speaks HTTP by hand, so that the
 * test can count the connections the client opens and can answer in the ways
 * a server answers: with a length, in chunks, or by ending the connection.
 *
 * The server is a process of its own: a build runs the source of a program
 * and the program it delivers, and it runs them while the test waits, so a
 * server that shared the process of the test could not answer them.
 *
 * The server answers every request with the same body, because a build checks
 * the program it delivers against the source it was made from, and the two
 * have to print the same thing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { scratch } from "./scratch.ts";
import { run } from "../core/process.ts";
import { writeProject } from "./project.ts";

const QUIET = { stage: () => {} };

/** How the server answers a request. */
type Mode = "keep-alive" | "close" | "chunked";

/** The server script: a socket that speaks HTTP by hand and writes down what it took. */
const SERVER_SOURCE = `const net = require("node:net");
const fs = require("node:fs");
const mode = process.argv[2];
const log = process.argv[3];
const server = net.createServer((socket) => {
  fs.appendFileSync(log, "connection\\n");
  let seen = "";
  socket.on("data", (chunk) => {
    seen += chunk.toString("utf8");
    const end = seen.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    fs.appendFileSync(log, "request " + seen.slice(0, end).split("\\r\\n").join(" | ") + "\\n");
    seen = seen.slice(end + 4);
    if (mode === "chunked") {
      socket.write("HTTP/1.1 200 OK\\r\\ntransfer-encoding: chunked\\r\\n\\r\\n1\\r\\n6\\r\\n0\\r\\n\\r\\n");
    } else if (mode === "close") {
      socket.write("HTTP/1.1 200 OK\\r\\ncontent-length: 1\\r\\nconnection: close\\r\\n\\r\\n6");
      socket.end();
    } else {
      socket.write("HTTP/1.1 200 OK\\r\\ncontent-length: 1\\r\\n\\r\\n6");
    }
  });
});
server.listen(0, "127.0.0.1", () => { console.log(server.address().port); });
`;

/** A server that answers requests and writes down what it took. */
interface RawServer {
  port: number;
  /** The lines the server wrote down: one per connection, one per request. */
  log: () => Promise<string[]>;
  stop: () => Promise<void>;
}

async function startRawServer(mode: Mode): Promise<RawServer> {
  const directory = await scratch("blaze-http-keep-alive-server-");
  const script = join(directory, "server.cjs");
  const logPath = join(directory, "log.txt");
  await writeFile(script, SERVER_SOURCE, "utf8");
  await writeFile(logPath, "", "utf8");
  const server: ChildProcess = spawn("node", [script, mode, logPath], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    server.stdout?.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0) return;
      resolve(Number(text.slice(0, end)));
    });
    server.on("error", reject);
  });
  return {
    port,
    log: async () => (await readFile(logPath, "utf8")).split("\n").filter((line) => line !== ""),
    stop: () =>
      new Promise<void>((resolve) => {
        server.once("exit", () => resolve());
        server.kill();
      }),
  };
}

/**
 * Builds a program that makes `count` requests to a port and prints every
 * answer.
 *
 * The program is written the way the language writes it, so that the source
 * runs as the specification of the program: a build checks the program it
 * delivers against the source, and the source is run by the toolchain of the
 * language it is written in.
 */
async function buildClient(port: number, count: number): Promise<string> {
  const directory = await scratch("blaze-http-keep-alive-");
  await writeFile(
    join(directory, "main.ts"),
    `const url = "http://127.0.0.1:${port}/";\n` +
      `function get() {\n` +
      `  return new Promise(function (onFulfilled) {\n` +
      `    const req = http.request(url, { method: "GET" }, (res) => {\n` +
      `      var content = "";\n` +
      `      res.on("data", (chunk) => { content += chunk; });\n` +
      `      res.on("end", () => { onFulfilled(+content); });\n` +
      `    });\n` +
      `    req.end();\n` +
      `  });\n` +
      `}\n` +
      `async function main() {\n` +
      `  for (var i = 0; i < ${count}; i += 1) {\n` +
      `    const body = await get();\n` +
      `    console.log(body);\n` +
      `  }\n` +
      `}\n` +
      `main();\n`,
    "utf8",
  );
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend: "machine",
    mode: "debug",
    runtime: "facil",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", "the client build succeeded");
  assert.ok(outcome.outputPath !== null, "the client build delivered a binary");
  return outcome.outputPath as string;
}

/**
 * Runs a client and answers how many connections its requests opened.
 *
 * A build runs the program it delivers as well, so the connections are counted
 * from the moment the program is run and not from the moment the server was
 * started.
 */
async function runClient(client: string, server: RawServer): Promise<{ output: string; connections: number }> {
  const before = (await server.log()).filter((line) => line === "connection").length;
  const answered = run(client, [], { timeoutMs: 30_000 });
  assert.equal(answered.code, 0, answered.stderr);
  const after = (await server.log()).filter((line) => line === "connection").length;
  return { output: answered.stdout.trim(), connections: after - before };
}

test("the client keeps one connection open between two requests", async () => {
  const server = await startRawServer("keep-alive");
  try {
    const client = await buildClient(server.port, 3);
    const answered = await runClient(client, server);
    assert.equal(answered.output.split("\n").join(","), "6,6,6", "the client read every answer");
    assert.equal(answered.connections, 1, "the three requests shared one connection");
  } finally {
    await server.stop();
  }
});

test("the client asks the server to keep the connection open", async () => {
  const server = await startRawServer("keep-alive");
  try {
    const client = await buildClient(server.port, 1);
    const answered = await runClient(client, server);
    assert.equal(answered.output, "6", "the client read the answer");
    const requests = (await server.log()).filter((line) => line.startsWith("request "));
    assert.match(
      requests.join("\n"),
      /connection:\s*keep-alive/i,
      "the request asks for a connection that stays open",
    );
  } finally {
    await server.stop();
  }
});

test("a server that ends the connection makes the client open a new one", async () => {
  const server = await startRawServer("close");
  try {
    const client = await buildClient(server.port, 3);
    const answered = await runClient(client, server);
    assert.equal(answered.output.split("\n").join(","), "6,6,6", "the client read every answer");
    assert.equal(answered.connections, 3, "each request that ends the connection opened its own");
  } finally {
    await server.stop();
  }
});

test("the client reads a body that ends where the answer says it ends", async () => {
  // The answer carries a body of one byte and then nothing at all: a client
  // that read until the connection ended would wait for an end that never
  // comes.
  const server = await startRawServer("keep-alive");
  try {
    const client = await buildClient(server.port, 1);
    const answered = await runClient(client, server);
    assert.equal(answered.output, "6", "the client read the body and stopped there");
    assert.equal(answered.connections, 1, "the answer did not end the connection");
  } finally {
    await server.stop();
  }
});

test("the client reads an answer that is written in chunks", async () => {
  const server = await startRawServer("chunked");
  try {
    const client = await buildClient(server.port, 1);
    const answered = await runClient(client, server);
    assert.equal(answered.output, "6", "the client read the chunked body as one body");
  } finally {
    await server.stop();
  }
});

/** Builds a program of its own: the source it is given, as a binary. */
async function buildProgram(source: string): Promise<string> {
  const directory = await scratch("blaze-http-keep-alive-program-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend: "machine",
    mode: "debug",
    runtime: "facil",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", "the program build succeeded");
  assert.ok(outcome.outputPath !== null, "the program build delivered a binary");
  return outcome.outputPath as string;
}

/** Opens a socket to a port and waits until it is connected. */
async function openSocket(port: number): Promise<Socket> {
  const socket = connect({ port, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

/** Reads one answer from a socket: its headers and the body they name. */
function readAnswer(socket: Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      const end = seen.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /content-length:\s*(\d+)/i.exec(seen.slice(0, end));
      const body = seen.slice(end + 4);
      if (length !== null && body.length < Number(length[1])) return;
      socket.off("data", onData);
      resolve(seen);
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("the server answers two requests over one connection", async () => {
  const port = 18140;
  const binary = await buildProgram(`const port = ${port};\nhttp.serve(port);\n`);
  const server = spawn(binary, [], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    // The server binds the port before it answers, so the socket is opened
    // until the server is there.
    let socket: Socket | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        socket = await openSocket(port);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(socket !== null, "the server took the connection");
    const first = readAnswer(socket as Socket);
    (socket as Socket).write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const firstAnswer = await first;
    assert.match(firstAnswer, /hello, world/i, "the server answered the first request");
    assert.match(firstAnswer, /connection:\s*keep-alive/i, "the server keeps the connection open");
    const second = readAnswer(socket as Socket);
    (socket as Socket).write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const secondAnswer = await second;
    assert.match(secondAnswer, /hello, world/i, "the server answered the second request on the same connection");
    (socket as Socket).destroy();
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("a program that closes its server does not wait for the event loop to tick", async () => {
  // The event loop is stopped from another thread, and the thread that waits
  // for an event is not woken by the request: it notices the request when the
  // wait is over. A program that closes the server it started waits for that
  // wait, so the tick the event loop waits for is what the program waits for.
  const binary = await buildProgram(
    `const port = 18141;\n` +
      `const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok\\n"); });\n` +
      `server.listen(port, "127.0.0.1", () => { server.close(); });\n`,
  );
  const started = Date.now();
  const answered = run(binary, [], { timeoutMs: 30_000 });
  const elapsed = Date.now() - started;
  assert.equal(answered.code, 0, answered.stderr);
  assert.ok(elapsed < 500, `the program exited in ${elapsed}ms, which is longer than a tick`);
});

/**
 * The HTTP API a module function has.
 *
 * A program that serves HTTP is a program body and a module: the body starts
 * the server and the module answers the requests. The module is compiled on
 * its own — by the C backend or by the machine backend, as the project names
 * — and the program links it beside itself, so the same source is served by
 * both backends and the answers the two give are the answers the server
 * gives.
 *
 * The tests below build one server per backend and ask them the same
 * questions: the routes, the request they read, the response they write, the
 * errors, and what happens when the requests come in at once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
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

/** The port the server of these tests is served on. */
const PORT = 18170;

/**
 * The handler the tests ask questions with.
 *
 * Every route answers as JSON, so what a test reads is the answer the
 * handler wrote and not what the runtime made of it.
 */
const HANDLER = `export function handler(req: any, res: any): void {
	const path = http.requestPath(req);
	const method = http.requestMethod(req);
	if (path === \`/health\`) {
		http.responseStatus(res, 200);
		http.responseHeader(res, \`Content-Type\`, \`application/json\`);
		http.responseEnd(res, \`{"status":"ok"}\`);
	} else if (path === \`/echo\`) {
		const body = http.requestBody(req);
		http.responseStatus(res, 200);
		http.responseHeader(res, \`Content-Type\`, \`application/json\`);
		http.responseEnd(res, \`{"echo":\${body}}\`);
	} else if (path === \`/method\`) {
		http.responseStatus(res, 200);
		http.responseHeader(res, \`Content-Type\`, \`text/plain\`);
		http.responseEnd(res, method);
	} else if (path === \`/header\`) {
		http.responseStatus(res, 200);
		http.responseHeader(res, \`Content-Type\`, \`text/plain\`);
		http.responseEnd(res, http.requestHeader(req, \`x-blaze\`));
	} else {
		http.responseStatus(res, 404);
		http.responseHeader(res, \`Content-Type\`, \`application/json\`);
		http.responseEnd(res, \`{"error":"not found"}\`);
	}
}
`;

/** The body of the program: it starts the server and hands it the handler. */
function mainSource(port: number): string {
  return `import { handler } from "./handler.ts";\n` +
    `const server = http.createServer(handler);\n` +
    `server.listen(${port}, "127.0.0.1", () => {});\n`;
}

/**
 * Builds the server of one backend and returns the binary it produced.
 *
 * The two files of the project are the program and the module beside it, and
 * the module is the one the backend compiles.
 */
async function buildServer(backend: "c" | "machine", port: number = PORT): Promise<string> {
  const directory = await scratch(`blaze-http-module-${backend}-`);
  await writeFile(join(directory, "main.ts"), mainSource(port), "utf8");
  await writeFile(join(directory, "handler.ts"), HANDLER, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend,
    mode: "debug",
    runtime: "facil",
  });
  // The build runs the rules alone: a module is compiled by the backend the
  // project names, and what is being tested here is what the module and the
  // runtime make of a request, not what a model has to say about it.
  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, QUIET, "build");
  assert.equal(outcome.build.status, "success", `the ${backend} build succeeded`);
  assert.ok(outcome.outputPath !== null, `the ${backend} build delivered a binary`);
  return outcome.outputPath as string;
}

/** The binary of one backend, built once and kept. */
const binaries = new Map<string, Promise<string>>();

function binaryOf(backend: "c" | "machine"): Promise<string> {
  const held = binaries.get(backend);
  if (held !== undefined) return held;
  const built = buildServer(backend);
  binaries.set(backend, built);
  return built;
}

/** Starts a server in the background and waits until it answers. */
async function startServer(binary: string): Promise<ChildProcess> {
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
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
  return server;
}

/** Asks a server a question without waiting for the answer first. */
function askAsync(path: string, extra: readonly string[], port: number): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    execFile(
      "curl",
      ["-s", "-i", "--max-time", "5", ...extra, `http://127.0.0.1:${port}${path}`],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new assert.AssertionError({ message: `curl failed: ${stderr}` }));
          return;
        }
        resolve(readAnswer(stdout));
      },
    );
  });
}

/** What a request was answered with. */
interface Answer {
  status: string;
  headers: string;
  body: string;
}

/** Asks a server a question and reads the answer it gave. */
function ask(path: string, extra: readonly string[] = [], port: number = PORT): Answer {
  let lastError = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = run(
      "curl",
      ["-s", "-i", "--max-time", "5", ...extra, `http://127.0.0.1:${port}${path}`],
      { timeoutMs: 10_000 },
    );
    if (result.code === 0 && result.stdout.length > 0) return readAnswer(result.stdout);
    lastError = result.stderr.trim();
    run("sleep", ["0.25"]);
  }
  throw new assert.AssertionError({ message: `the server did not answer ${path}: ${lastError}` });
}

/** What an answer of a server carries, read out of what it wrote. */
function readAnswer(stdout: string): Answer {
  const split = stdout.indexOf("\r\n\r\n");
  const head = split < 0 ? stdout : stdout.slice(0, split);
  const body = split < 0 ? "" : stdout.slice(split + 4);
  const status = /HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? "";
  return { status, headers: head, body };
}

/** The value of a header of an answer, read as the answer carries it. */
function headerOf(answer: Answer, name: string): string {
  const line = answer.headers
    .split("\r\n")
    .find((one) => one.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line === undefined ? "" : line.slice(name.length + 1).trim();
}

/**
 * Asks a server of one backend a question and stops the server again.
 *
 * The server is started for the question and stopped after it, so that two
 * tests never share one.
 */
async function withServer(
  backend: "c" | "machine",
  question: (port: number) => void | Promise<void>,
): Promise<void> {
  const binary = await binaryOf(backend);
  const server = await startServer(binary);
  try {
    await question(PORT);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

for (const backend of ["c", "machine"] as const) {
  test(`the ${backend} backend serves a request a module function answers`, async () => {
    await withServer(backend, (port) => {
      const answer = ask("/health", [], port);
      assert.equal(answer.status, "200", "the answer is a 200");
      assert.equal(answer.body, `{"status":"ok"}`, "the body is what the handler wrote");
      assert.equal(headerOf(answer, "Content-Type"), "application/json", "the header is the one the handler set");
    });
  });

  test(`the ${backend} backend reads the body of a request a module function answers`, async () => {
    await withServer(backend, (port) => {
      const answer = ask("/echo", ["-X", "POST", "-d", `{"a":1}`], port);
      assert.equal(answer.status, "200", "the answer is a 200");
      assert.equal(answer.body, `{"echo":{"a":1}}`, "the body is what was posted");
    });
  });

  test(`the ${backend} backend reads the method and the headers of a request`, async () => {
    await withServer(backend, (port) => {
      const method = ask("/method", ["-X", "PUT"], port);
      assert.equal(method.body, "PUT", "the method is the one the request was sent with");
      const header = ask("/header", ["-H", "x-blaze: blaze"], port);
      assert.equal(header.body, "blaze", "the header is the one the request carried");
    });
  });

  test(`the ${backend} backend answers a path no route serves with a 404`, async () => {
    await withServer(backend, (port) => {
      const answer = ask("/nowhere", [], port);
      assert.equal(answer.status, "404", "the answer is a 404");
      assert.equal(answer.body, `{"error":"not found"}`, "the body is what the handler wrote");
    });
  });

  test(`the ${backend} backend answers every request of a burst`, async () => {
    await withServer(backend, async (port) => {
      // The requests are in flight at the same time: the runtime serves them
      // on the thread it serves requests on, and each of them has a request
      // and a response of its own.
      const answers = await Promise.all(Array.from({ length: 8 }, () => askAsync("/health", [], port)));
      for (const answer of answers) {
        assert.equal(answer.status, "200", "every request of the burst was answered");
        assert.equal(answer.body, `{"status":"ok"}`, "every request of the burst was answered the same way");
      }
    });
  });
}

test("the two backends answer the same request the same way", async () => {
  const answers = new Map<string, Answer>();
  for (const backend of ["c", "machine"] as const) {
    await withServer(backend, (port) => {
      answers.set(backend, ask("/health", [], port));
    });
  }
  const c = answers.get("c") as Answer;
  const machine = answers.get("machine") as Answer;
  assert.equal(machine.status, c.status, "the two backends answer with the same status");
  assert.equal(machine.body, c.body, "the two backends answer with the same body");
  assert.equal(
    headerOf(machine, "Content-Type"),
    headerOf(c, "Content-Type"),
    "the two backends answer with the same headers",
  );
});

test("the driver writes the bridge between the runtime and a module function", () => {
  const phase = phaseOf("typescript", { "main.ts": mainSource(PORT), "handler.ts": HANDLER }, "main.ts");
  const resolved = resolveProgram(
    phase.body as never,
    phase.program,
    phase.objectNames,
    phase.objectLayouts,
    phase.objectKeys,
  );
  const written = generateProgramDriver(resolved, true, "machine");
  assert.match(written, /blaze_http_bridge_handler/, "the driver writes the bridge");
  assert.match(written, /blaze_http_route_register/, "the driver registers the handler with the runtime");
});

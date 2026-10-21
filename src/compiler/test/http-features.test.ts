/**
 * The HTTP features Blaze Pulse is built on: routing on the path of a
 * request, the headers of a response, an event stream, a monotonic clock, and
 * a handler that shares the state of the program that registered it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
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

/** The port the programs of this suite are served on. */
const PORT = 18150;

/**
 * Builds a program and returns the binary it produced.
 *
 * The source is written so that it says nothing when it is run as a source:
 * a build checks the binary against the source, and a source that prints
 * something the binary does not print is a source that does not describe the
 * program.
 */
async function buildBinary(source: string, port: number = PORT): Promise<string> {
  const directory = await scratch("blaze-http-features-");
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
  assert.equal(outcome.build.status, "success", "the program built");
  assert.ok(outcome.outputPath !== null, "the build delivered a binary");
  return outcome.outputPath as string;
}

/** Starts a server in the background and waits until it answers. */
async function startServer(binary: string, port: number): Promise<ChildProcess> {
  const server = spawn(binary, [String(port)], { stdio: ["ignore", "pipe", "pipe"] });
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

/** Curls a path, retrying while the server is starting up. */
async function curl(path: string, port: number = PORT): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = run("curl", ["-s", "--max-time", "2", `http://localhost:${port}${path}`], { timeoutMs: 5_000 });
    if (result.code === 0 && result.stdout.length > 0) return result.stdout;
    lastError = result.stderr.trim();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new assert.AssertionError({ message: `the server did not answer ${path}: ${lastError}` });
}

/** A program that routes on the path of the request it is serving. */
const ROUTING_SOURCE = `
const server = http.createServer((req: any, res: any) => {
	const path = req.path;
	const method = req.method;
	if (path === "/hello") {
		res.writeHead(200);
		res.setHeader("Content-Type", "text/plain");
		res.end(\`hello \${method}\`);
	} else {
		res.writeHead(404);
		res.end("no such path");
	}
});

server.listen(${PORT}, "127.0.0.1", () => {});
`;

test("a program routes on the path of the request", async () => {
  const binary = await buildBinary(ROUTING_SOURCE);
  const server = await startServer(binary, PORT);
  try {
    assert.equal(await curl("/hello"), "hello GET");
    assert.equal(await curl("/nowhere"), "no such path");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("the headers a program sets are the headers the answer carries", async () => {
  const binary = await buildBinary(ROUTING_SOURCE);
  const server = await startServer(binary, PORT);
  try {
    const result = run(
      "curl",
      ["-s", "-i", "--max-time", "2", `http://localhost:${PORT}/hello`],
      { timeoutMs: 5_000 },
    );
    assert.match(result.stdout, /Content-Type:\s*text\/plain/, "the answer carries the header the program set");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/** A program that keeps a counter and publishes what it counted. */
const STREAM_SOURCE = `
const state = new Float64Array(4);

function record(): void {
	state[0] += 1;
	state[1] = performance.now();
}

const server = http.createServer((req: any, res: any) => {
	if (req.path === "/events") {
		http.sseSubscribe(res);
		http.ssePublish("data: one\\n\\n");
	} else {
		record();
		res.writeHead(200);
		res.end(\`counted \${state[0]}\`);
	}
});

server.listen(${PORT}, "127.0.0.1", () => {});
`;

test("a program publishes to an event stream and keeps the state it shares with its handler", async () => {
  const binary = await buildBinary(STREAM_SOURCE);
  const server = await startServer(binary, PORT);
  try {
    // The handler writes to the state the program owns, and the answer says
    // what it wrote: the state is shared, not copied.
    assert.equal(await curl("/count"), "counted 1");
    assert.equal(await curl("/count"), "counted 2");

    // The event stream carries what was published to it.
    const stream = run("curl", ["-s", "-N", "--max-time", "2", `http://localhost:${PORT}/events`], { timeoutMs: 5_000 });
    assert.match(stream.stdout, /data: one/, "the stream carries the event the program published");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("the clock of a program is read twice and the two readings are two calls", () => {
  const source = `
const first = performance.now();
const second = performance.now();
console.log(second - first);
`;
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const resolved = resolveProgram(
    phase.body as never,
    phase.program,
    phase.objectNames,
    phase.objectLayouts,
    phase.objectKeys,
  );
  const written = generateProgramDriver(resolved, false);
  assert.match(written, /blaze_rt_monotonic_ms/, "the clock is the runtime's monotonic clock");
  // The clock reads the world, so the optimizer may not turn two readings into
  // one: the duration a program measures is the difference of two readings, and
  // the order they are read in is the program's own.
  const readings = written.match(/blaze_rt_monotonic_ms\(\)/g) ?? [];
  assert.equal(readings.length, 2, "the two readings are two calls");
  assert.match(written, /double \w+ = blaze_rt_monotonic_ms\(\);/, "each reading is a value of its own");
});

test("a program that reads the path of a request is compiled with the path of the request", () => {
  const source = `
const server = http.createServer((req: any, res: any) => {
	res.writeHead(200);
	res.end(req.path);
});
`;
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const resolved = resolveProgram(
    phase.body as never,
    phase.program,
    phase.objectNames,
    phase.objectLayouts,
    phase.objectKeys,
  );
  const written = generateProgramDriver(resolved, true);
  assert.match(written, /blaze_http_req_path/, "the path of the request is read from the request");
});

test("a handler that shares the state of the program is given it", () => {
  const source = `
const state = new Float64Array(4);

const server = http.createServer((req: any, res: any) => {
	state[0] += 1;
	res.writeHead(200);
	res.end("counted");
});
`;
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const resolved = resolveProgram(
    phase.body as never,
    phase.program,
    phase.objectNames,
    phase.objectLayouts,
    phase.objectKeys,
  );
  const written = generateProgramDriver(resolved, true);
  assert.match(written, /blaze_capture_/, "the names the handler captured are held for it");
  assert.match(written, /state/, "the state is the program's own");
});

test("a number a handler captured is held for it as the number it is", () => {
  // The names a handler captured are held where the handler reads them, and a
  // number used to be held as an address — which is rounded to a whole number
  // on the way: a handler that captured 1.5 was given 1.
  const source = `
const scale = 1.5;

const server = http.createServer((req: any, res: any) => {
	console.log(scale);
	res.writeHead(200);
	res.end("counted");
});
`;
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const resolved = resolveProgram(
    phase.body as never,
    phase.program,
    phase.objectNames,
    phase.objectLayouts,
    phase.objectKeys,
  );
  const written = generateProgramDriver(resolved, true);
  assert.match(
    written,
    /blaze_capture_\w+ = \(blaze_capture_t\)\{ \.pointer = NULL, \.number = \(double\)\(1\.5\) \}/,
    "the number is held as the number it is",
  );
  assert.match(
    written,
    /\(blaze_capture_\w+\.number\)/,
    "the handler is given the number out of the holder",
  );
});

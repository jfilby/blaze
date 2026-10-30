/**
 * Checking a program.
 *
 * A function is checked against its contract, which is a mathematical
 * statement about what it must compute. A program has no such statement: it
 * is a sequence of statements whose only observable effect is what it prints.
 * So the build runs the source on its own toolchain, runs the delivered binary,
 * and compares the two: the program the compiler produced must say exactly what
 * the program in the repository says.
 *
 * A binary that never finishes, is killed, or fails is as wrong as one that
 * prints the wrong thing, and is reported the same way: against the first line
 * of the source it never printed, with the reason it stopped. Only a source
 * that cannot be run at all ends the build here, because that is not the
 * compiler's program to repair.
 *
 * The toolchain of a program is its language: a TypeScript program is checked
 * against `node`, which runs TypeScript directly.
 */

import { readFileSync, mkdtemp, writeFile, tmpdir, join } from "../core/platform.ts";
import { formatCommand, run, GENERATED_HEAP_BYTES, type RunResult } from "../core/process.ts";
import { CompilerError } from "../core/errors.ts";
import { usesSqliteSource } from "../runtime/sqlite.ts";
import { mentionsHttpModule } from "../runtime/http-needs.ts";
import type { ProgramMismatch, Runner } from "../core/types.ts";

/**
 * Whether a program is one that serves HTTP, whose run may outlive what it
 * prints.
 *
 * The question is asked of the code, not of the file: a comment that cites a
 * URL is prose, and a program that prints the word "http" is not a program
 * that serves it. Reading a mention in either as a server gave every such
 * program the server's five second deadline, which turned a program that
 * computes for longer than that into a verification that "did not finish".
 *
 * A `fetch` is the facility as much as an `http.` is: it makes a request, and
 * a request waits on a server, so the deadline a program that asks is given is
 * the one a program that serves is given. The question is the one the runtime
 * link is decided by, so that the source is run with the HTTP prelude whenever
 * the program the compiler builds carries the HTTP runtime.
 */
export function servesHttp(source: string): boolean {
  return mentionsHttpModule(source);
}

/**
 * The language a source is checked against: the command that runs it and the
 * flags it is run with.
 *
 * The flags are the toolchain's, not the source's: a TypeScript source is run
 * by node with the flags node needs to run TypeScript at all, and a Python
 * source is run by python3 with none.
 */
const TOOLCHAIN: Record<string, { command: string; flags: string[] }> = {
  typescript: { command: "node", flags: ["--experimental-transform-types"] },
  ts: { command: "node", flags: ["--experimental-transform-types"] },
  python: { command: "python3", flags: [] },
  py: { command: "python3", flags: [] },
};

/**
 * The command line Deno hands a program, for a source written for Deno and run
 * by the toolchain that runs TypeScript. The two hosts differ in one place: node
 * counts the program and the file it runs before the arguments a program was
 * given, and Deno hands over the arguments alone, so `Deno.args[0]` is what
 * `process.argv[2]` is under one and `process.argv[1]` is under the other. A
 * prelude is what makes the source mean here what it means there, and it is the
 * same shift the compiler reads `Deno.args` with, so the source and the binary
 * are given the same arguments whichever host wrote the source.
 */
const DENO_PRELUDE = "data:text/javascript,globalThis.Deno={args:process.argv.slice(2)}";
/**
 * The prelude a program that serves HTTP runs under with: the HTTP API of
 * node, the calls the compiler provides beside it, and the HTTP API of a
 * module function, which the program body does not use but the module beside
 * it may.
 *
 * The three-argument `http.request(url, options, callback)` is node's own. The
 * synchronous forms — `http.request(url, method, headers, body)` and
 * `fetch(url, method, headers, body)` — are the compiler's: they perform one
 * request and answer its body, and node has no synchronous request to answer
 * them with. Node's own `fetch` is not the compiler's either: it takes an
 * options object, and handed a method it refuses the call before the program
 * runs at all. A child process makes the request, the way the compiled client
 * makes it, and hands its body back.
 */
const HTTP_PRELUDE_SOURCE = `
globalThis.http = Object.assign({}, await import("node:http"));
const blazeNodeRequest = globalThis.http.request;
const { spawnSync } = await import("node:child_process");
const blazeRequestScript = [
  'const { readFileSync } = await import("node:fs");',
  'const { request } = await import("node:http");',
  'const { request: requestTls } = await import("node:https");',
  'const spec = JSON.parse(readFileSync(0, "utf8"));',
  'const url = new URL(spec.url);',
  'const headers = {};',
  'for (const [name, value] of spec.headers) headers[name] = value;',
  'const options = { method: spec.method || "GET", headers };',
  'const send = url.protocol === "https:" ? requestTls : request;',
  'const outgoing = send(url, options, (response) => {',
  '  const chunks = [];',
  '  response.on("data", (chunk) => chunks.push(chunk));',
  '  response.on("end", () => process.stdout.write(Buffer.concat(chunks)));',
  '});',
  'outgoing.on("error", () => process.stdout.write(""));',
  'outgoing.setTimeout(10000, () => outgoing.destroy());',
  'if (spec.body !== "") outgoing.write(spec.body);',
  'outgoing.end();',
].join("\\n");
function blazeHeaders(text) {
  const pairs = [];
  for (const line of String(text).split(/\\r?\\n/)) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    pairs.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return pairs;
}
function blazeRequest(url, method, headers, body) {
  const answer = spawnSync(process.execPath, ["--input-type=module", "-e", blazeRequestScript], {
    input: JSON.stringify({ url: String(url), method: String(method), headers: blazeHeaders(headers), body: String(body) }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return answer.stdout || "";
}
globalThis.fetch = function (url, method, headers, body) {
  return blazeRequest(url, method, headers, body);
};
globalThis.http.request = function (url, options, callback, body) {
  if (arguments.length >= 4) return blazeRequest(url, options, callback, body);
  return blazeNodeRequest(url, options, callback);
};
globalThis.http.serve = function () {};
globalThis.http.createServer = function () { return { listen: function () {} }; };
globalThis.http.serveSettings = function () {};
globalThis.http.serveTls = function () {};
globalThis.http.requestPath = function () { return ""; };
globalThis.http.requestMethod = function () { return ""; };
globalThis.http.requestHeader = function () { return ""; };
globalThis.http.requestBody = function () { return ""; };
globalThis.http.responseStatus = function () {};
globalThis.http.responseHeader = function () {};
globalThis.http.responseBody = function () {};
globalThis.http.responseEnd = function () {};
`;
const HTTP_PRELUDE_URL = `data:text/javascript,${encodeURIComponent(HTTP_PRELUDE_SOURCE)}`;

/**
 * The SQLite facility, as the source of a program runs it.
 *
 * Node has no `sqlite` global, so the source is run with a prelude that
 * provides one — the same way an HTTP source is run with a prelude that
 * provides `http`. The prelude is a JavaScript implementation of the same API,
 * over `node:sqlite`, and it is the second implementation of the API: the C
 * adapter is the first, and the two have to agree, because a program that
 * prints what one says and not the other fails its own verification.
 *
 * The handles are numbers, and they are the slots the handles are held in, so
 * that the source and the program the compiler built print the same handle.
 */
const SQLITE_PRELUDE_SOURCE = `
globalThis.sqlite = await (async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const handles = [];
  const hold = (value) => { handles.push(value); return handles.length - 1; };
  const take = (handle) => {
    const value = handles[handle];
    if (value === undefined) throw new Error("the handle is not a handle");
    return value;
  };
  const text = (value) => (value === null || value === undefined ? "" : String(value));
  const connection = (handle) => {
    const held = take(handle);
    if (held.kind !== "connection") throw new Error("the handle is not a database");
    return held;
  };
  const statement = (handle) => {
    const held = take(handle);
    if (held.kind !== "statement") throw new Error("the handle is not a statement");
    return held;
  };
  const cell = (held, index) => {
    if (held.current === null) return null;
    const column = held.columns[index];
    if (column === undefined) return null;
    const key = column.name === null || column.name === undefined ? column.column : column.name;
    const value = held.current[key];
    return value === undefined ? null : value;
  };
  return {
    open: (path) => hold({ kind: "connection", db: new DatabaseSync(text(path)), statements: [], error: "not an error", changes: 0, rowid: 0 }),
    close: (handle) => {
      if (handles[handle] === undefined) return;
      const held = connection(handle);
      for (const one of held.statements) one.closed = true;
      held.statements = [];
      held.db.close();
      handles[handle] = undefined;
    },
    exec: (handle, sql) => {
      const held = connection(handle);
      try {
        held.db.exec(text(sql));
        held.error = "not an error";
        return 1;
      } catch (failure) {
        held.error = String(failure.message);
        return 0;
      }
    },
    prepare: (handle, sql) => {
      const held = connection(handle);
      const stmt = held.db.prepare(text(sql));
      const one = { kind: "statement", db: held, stmt, columns: stmt.columns(), values: [], started: false, iterator: null, row: null, current: null };
      held.statements.push(one);
      held.error = "not an error";
      return hold(one);
    },
    bindText: (handle, index, value) => { statement(handle).values[index - 1] = text(value); },
    bindNumber: (handle, index, value) => { statement(handle).values[index - 1] = Number(value); },
    bindNull: (handle, index) => { statement(handle).values[index - 1] = null; },
    step: (handle) => {
      const held = statement(handle);
      if (!held.started) {
        held.started = true;
        if (held.columns.length > 0) {
          held.iterator = held.stmt.iterate(...held.values);
          held.row = held.iterator.next();
        } else {
          const result = held.stmt.run(...held.values);
          held.db.changes = result.changes;
          held.db.rowid = result.lastInsertRowid;
          held.row = { done: true, value: null };
        }
      } else {
        held.row = held.iterator.next();
      }
      held.db.error = "not an error";
      if (held.row.done) return 0;
      held.current = held.row.value;
      return 1;
    },
    columnCount: (handle) => statement(handle).columns.length,
    columnType: (handle, index) => {
      const held = statement(handle);
      const value = cell(held, index);
      if (value === null) return 0;
      if (typeof value === "bigint") return 1;
      if (typeof value === "number") {
        const declared = held.columns[index] === undefined ? null : held.columns[index].type;
        if (declared !== null && /REAL|FLOAT|DOUBLE/i.test(declared)) return 2;
        return Number.isInteger(value) ? 1 : 2;
      }
      if (typeof value === "string") return 3;
      return 4;
    },
    columnNumber: (handle, index) => {
      const held = statement(handle);
      const value = cell(held, index);
      return value === null ? 0 : Number(value);
    },
    columnText: (handle, index) => {
      const held = statement(handle);
      const value = cell(held, index);
      return value === null ? "" : String(value);
    },
    finalize: (handle) => {
      if (handles[handle] === undefined) return;
      const held = statement(handle);
      held.closed = true;
      handles[handle] = undefined;
    },
    changes: (handle) => connection(handle).changes,
    lastInsertRowid: (handle) => connection(handle).rowid,
    error: (handle) => connection(handle).error,
  };
})();
`;

/**
 * The prelude that gives a source a `sqlite` to call.
 *
 * It is written to a file of its own rather than carried in the command line:
 * the prelude is a program of a few kilobytes, and a command line that holds
 * it is a command line no reader can read — and the command line is what the
 * build prints when the source does not run.
 */
let sqlitePrelude: Promise<string> | null = null;

async function sqlitePreludePath(): Promise<string> {
  sqlitePrelude ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "blaze-sqlite-"));
    const path = join(directory, "sqlite-prelude.mjs");
    await writeFile(path, SQLITE_PRELUDE_SOURCE, "utf8");
    return path;
  })();
  return sqlitePrelude;
}

/** Whether a source reads the command line the way a Deno program does. */
function readsDenoArgs(source: string): boolean {
  return /\bDeno\s*\.\s*args\b/.test(source);
}

/** One line of the first difference between two programs, with both outputs. */
export type { ProgramMismatch };

export interface ProgramVerification {
  passed: boolean;
  /** What the source printed. */
  expected: string;
  /** What the delivered binary printed. */
  actual: string;
  difference?: ProgramMismatch;
}

export interface ProgramVerificationRequest {
  language: string;
  /** The entry module, as the toolchain runs it. */
  sourcePath: string;
  /** Directory the source is run in, so its imports resolve. */
  directory: string;
  /** The delivered binary. */
  runner: Runner;
  /** The arguments the program is given, as they are given on the command line. */
  arguments?: readonly string[];
}

/**
 * Where two outputs first differ, with both of them: a repair is shown what
 * the program said and what it should have said, not only the one line.
 */
function firstDifference(expected: string, actual: string): ProgramMismatch | null {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index += 1) {
    const left = expectedLines[index] ?? "";
    const right = actualLines[index] ?? "";
    if (left !== right) {
      return { line: index + 1, expected: left, actual: right, expectedOutput: expected, actualOutput: actual };
    }
  }
  return null;
}

/**
 * How a delivered program stopped before it printed what its source prints. A
 * program that stops is as wrong as one that prints the wrong thing, and the
 * build repairs it the same way, so the reason is part of the verdict rather
 * than the end of it.
 */
function stopFailure(binary: RunResult): string | null {
  // A program that never ran printed nothing, and nothing it was supposed to
  // print can be missing from that. Reporting it as a run that produced the
  // wrong output would hand a program that never executed to the model as a
  // verified implementation, and reporting it as a clean exit would say it
  // verified against itself.
  if (binary.spawnError !== undefined) return `the delivered program did not run: ${binary.spawnError}`;
  if (binary.timedOut) return "the delivered program did not finish";
  if (binary.signal !== null) return `the delivered program was terminated by ${binary.signal}`;
  if (binary.code === null) return "the delivered program did not report an exit status";
  if (binary.code !== 0) return `the delivered program exited with status ${binary.code}`;
  return null;
}

/**
 * What the program a candidate belongs to printed, what the source prints
 * instead, and where the two part: on a line, or at the line a program that
 * stopped never got to. A stopped program has no line it disagrees on, so the
 * verdict points at the first line of the source it never printed.
 */
function stoppedMismatch(failure: string, expectedOutput: string, actualOutput: string, errorOutput: string): ProgramMismatch {
  const line = actualOutput === "" ? 1 : actualOutput.split("\n").length + 1;
  return {
    line,
    expected: expectedOutput.split("\n")[line - 1] ?? "",
    actual: actualOutput.split("\n")[line - 1] ?? "",
    expectedOutput,
    actualOutput,
    failure,
    ...(errorOutput === "" ? {} : { failureOutput: errorOutput }),
  };
}

/**
 * Runs the source and the delivered binary, and compares what they print. The
 * source is the specification: a binary that says anything else is wrong, even
 * when every function in it satisfies its contract.
 */
export async function verifyProgram(request: ProgramVerificationRequest): Promise<ProgramVerification> {
  const toolchain = TOOLCHAIN[request.language.toLowerCase()];
  if (toolchain === undefined) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: `a program in ${request.language} cannot be checked`,
      detail: `checked against: ${Object.keys(TOOLCHAIN).join(", ")}; a program is checked against the toolchain that runs its source`,
    });
  }

  // A program reads the arguments it is given, so both runs get the same ones.
  const arguments_ = [...(request.arguments ?? [])];
  // A source written for Deno is run with the command line Deno hands a
  // program, so that the oracle is the source as it was written rather than a
  // source that cannot run at all. The preludes are the ones a TypeScript
  // source needs: a source of another language is run as it is.
  const deno = readFileSync(request.sourcePath, "utf8");
  const httpSource = servesHttp(deno);
  const sqliteSource = usesSqliteSource(deno);
  // The preludes are the ones node needs, and a source of another language is
  // run as it is.
  const before = [...toolchain.flags];
  if (toolchain.command === "node") {
    if (readsDenoArgs(deno)) before.push("--import", DENO_PRELUDE);
    if (httpSource) before.push("--import", HTTP_PRELUDE_URL);
    if (sqliteSource) before.push("--import", await sqlitePreludePath());
  }
  const source = run(toolchain.command, [...before, request.sourcePath, ...arguments_], { cwd: request.directory, timeoutMs: 120_000 });
  if (source.spawnError !== undefined) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: `${toolchain.command} is not available, so the program cannot be checked`,
      detail: `${source.spawnError}\ninstall ${toolchain.command}, or build this project as a function entry`,
    });
  }
  if (source.code !== 0) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: "the program source does not run",
      detail: `${formatCommand(toolchain.command, [...before, request.sourcePath, ...arguments_])}\n${source.stderr.trim()}`,
    });
  }

  // The delivered program is given a heap of its own: one that allocates
  // without bound is then refused by its allocator, which says what it was
  // doing, rather than killed by a system that has run out of memory and takes
  // the build with it.
  // A server may run until it is stopped, so its deadline is the short one a
  // server is given; everything else gets the deadline a computation is given.
  const binaryTimeout = httpSource ? 5_000 : 120_000;
  const binary = run(request.runner.command, [...request.runner.args, ...arguments_], {
    cwd: request.directory,
    timeoutMs: binaryTimeout,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  const printed = binary.stdout.trim();
  const stopped = stopFailure(binary);
  if (stopped !== null) {
    // An HTTP server may run until it is stopped by a timeout; if it has
    // already printed everything its source prints, that is a successful
    // verification rather than a failure.
    if (binary.timedOut && printed === source.stdout.trim()) {
      return { passed: true, expected: source.stdout, actual: binary.stdout };
    }
    // A program that stopped is a verdict, not the end of the build: the
    // functions the program is the only oracle for are regenerated with why it
    // stopped and with what it managed to print before it did.
    return {
      passed: false,
      expected: source.stdout,
      actual: printed,
      difference: stoppedMismatch(stopped, source.stdout, printed, binary.stderr.trim()),
    };
  }

  const difference = firstDifference(source.stdout, binary.stdout);
  return {
    passed: difference === null,
    expected: source.stdout,
    actual: binary.stdout,
    ...(difference === null ? {} : { difference }),
  };
}

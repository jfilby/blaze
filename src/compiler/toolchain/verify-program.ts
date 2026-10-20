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

import { readFileSync } from "node:fs";
import { formatCommand, run, GENERATED_HEAP_BYTES, type RunResult } from "../core/process.ts";
import { CompilerError } from "../core/errors.ts";
import type { ProgramMismatch, Runner } from "../core/types.ts";

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
 */
const HTTP_PRELUDE = [
  "globalThis.http=Object.assign({}, await import('node:http'));",
  "globalThis.http.serve=function(){};",
  "globalThis.http.createServer=function(){return{listen:function(){}}};",
  "globalThis.http.serveSettings=function(){};",
  "globalThis.http.serveTls=function(){};",
  "globalThis.http.requestPath=function(){return '';};",
  "globalThis.http.requestMethod=function(){return '';};",
  "globalThis.http.requestHeader=function(){return '';};",
  "globalThis.http.requestBody=function(){return '';};",
  "globalThis.http.responseStatus=function(){};",
  "globalThis.http.responseHeader=function(){};",
  "globalThis.http.responseBody=function(){};",
  "globalThis.http.responseEnd=function(){};",
].join("");
const HTTP_PRELUDE_URL = `data:text/javascript,${HTTP_PRELUDE}`;

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
  const httpSource = /\bhttp\b/.test(deno);
  const before = [...toolchain.flags];
  if (before.length > 0) {
    if (readsDenoArgs(deno)) before.push("--import", DENO_PRELUDE);
    if (httpSource) before.push("--import", HTTP_PRELUDE_URL);
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
  const isHttpSource = /\bhttp\b/.test(readFileSync(request.sourcePath, "utf8"));
  const binaryTimeout = isHttpSource ? 5_000 : 120_000;
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

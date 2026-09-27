/**
 * Child process execution.
 *
 * The compiler delegates all native work (assembling, linking, running test
 * vectors, benchmarking) to existing tools through this single entry point, so
 * timeouts, output capture and diagnostics behave identically everywhere.
 */

import { spawnSync } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  maxBufferBytes?: number;
}

export interface RunResult {
  command: string;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationNs: bigint;
  timedOut: boolean;
  /** Set when the process could not be spawned at all (e.g. missing tool). */
  spawnError?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
  });
  const durationNs = process.hrtime.bigint() - started;
  const spawnFailure = result.error as NodeJS.ErrnoException | undefined;

  return {
    command: formatCommand(command, args),
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationNs,
    // An expired timeout surfaces as an ETIMEDOUT error and the child is then
    // killed with killSignal, so a death by SIGTERM alone does not mean we
    // stopped it: something outside this process did, and reporting that as a
    // timeout blames the program for a timeout it never had.
    timedOut: spawnFailure?.code === "ETIMEDOUT",
    // Every spawn failure leaves status and signal null, which reads as a
    // clean exit to a consumer that only tests code. Report all of them, not
    // just a missing binary, so a process that never ran is never mistaken
    // for one that ran correctly.
    spawnError:
      spawnFailure === undefined
        ? undefined
        : spawnFailure.code === "ENOENT"
          ? `${command}: not found`
          : spawnFailure.message,
  };
}

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
  const spawnError = result.error as NodeJS.ErrnoException | undefined;

  return {
    command: formatCommand(command, args),
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationNs,
    timedOut: result.signal === "SIGTERM" || spawnError?.code === "ETIMEDOUT",
    spawnError: spawnError?.code === "ENOENT" ? `${command}: not found` : undefined,
  };
}

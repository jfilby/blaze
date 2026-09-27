/**
 * Child process execution.

 * The compiler delegates all native work (assembling, linking, running test
 * vectors, benchmarking) to existing tools through this single entry point, so
 * timeouts, output capture and diagnostics behave identically everywhere.
 *
 * A run of code the compiler generated is given a heap limit, because the one
 * thing a candidate can do that a tool never does is allocate until the
 * machine is out of memory. Bounded, that is a program that stops and says so;
 * unbounded, it is a build that dies with it and reports nothing.
 */

import { spawnSync } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  maxBufferBytes?: number;
  /**
   * The heap, in bytes, the child may grow. A program that allocates without
   * bound asks the system for memory until there is none, and the system
   * answers by killing the process: the run ends as a signal, its output is
   * lost, and a machine short of memory takes the compiler with it. Bounded,
   * the same program is refused by its own allocator instead, which says what
   * it was doing and leaves the run to be reported.
   *
   * The bound is on the heap rather than on the whole address space, because a
   * runtime reserves address space for itself long before it allocates: V8
   * claims tens of gigabytes for its pointer compression cage, so a limit on
   * address space would refuse a program that has allocated nothing at all.
   */
  heapBytes?: number;
}

export interface RunResult {
  command: string;
  /** The exit status, or null when the run did not exit on its own terms. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationNs: bigint;
  /** True when the run was stopped at its deadline rather than finishing. */
  timedOut: boolean;
  /**
   * Set when the process could not be spawned at all (e.g. missing tool).
   * Never set for a run that started and was then stopped at its deadline:
   * that run did start, and a consumer that reads the two as one thing blames
   * the program for a timeout it was given.
   */
  spawnError?: string;
}

/**
 * The signal a run past its deadline is killed with. A run is stopped by the
 * compiler rather than asked to stop, so the signal may not be one a program
 * can trap or ignore: SIGTERM is a request, and a program that traps it has
 * answered by doing nothing, which leaves the deadline unenforced for exactly
 * as long as the program wanted.
 */
const KILL_SIGNAL = "SIGKILL";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The heap a generated program is given, which is generous: it is meant to
 * stop a runaway allocation, not to ration a program that works.
 */
export const GENERATED_HEAP_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The line a bounded run writes when the program itself is not there. A shell
 * reports a command it cannot find as an exit status, which a program is free
 * to choose, so the wrapper says so in words instead: a program that was never
 * found and a program that chose that status must not read alike.
 */
const MISSING = "blaze: no such program: ";

/**
 * The command as the shell runs it under a heap limit: a shell that sets the
 * limit and then `exec`s the program, so the program keeps its own process id,
 * its own exit status and its own signal. Nothing is read back through the
 * shell, so a program that stops is still told apart from one that was never
 * started.
 *
 * A shell that cannot set the limit says so and exits 125 rather than running
 * the program unbounded, because an unbounded run is the thing being fixed.
 */
function bounded(command: string, args: readonly string[], bytes: number): { command: string; args: string[] } {
  const kilobytes = Math.max(1, Math.floor(bytes / 1024));
  return {
    command: "/bin/sh",
    args: [
      "-c",
      [
        `ulimit -d ${kilobytes} 2>/dev/null || { echo "blaze: this shell cannot bound the memory of a program" >&2; exit 125; }`,
        `command -v "$0" >/dev/null 2>&1 || { echo "${MISSING}$0" >&2; exit 127; }`,
        `exec "$0" "$@"`,
      ].join("\n"),
      command,
      ...args,
    ],
  };
}

export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const started = process.hrtime.bigint();
  // The limit is applied by the shell the program is exec'd from, so what the
  // result reports is the program: the command named here is the one asked
  // for, not the shell that bounded it.
  const spawned = options.heapBytes === undefined ? { command, args } : bounded(command, args, options.heapBytes);
  const result = spawnSync(spawned.command, spawned.args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    killSignal: KILL_SIGNAL,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
  });
  const durationNs = process.hrtime.bigint() - started;
  const spawnFailure = result.error as NodeJS.ErrnoException | undefined;
  const stderr = result.stderr ?? "";
  // A bounded run reaches the program through a shell, so a program that is
  // not there is the shell's exit status rather than a failure to spawn. It
  // is still a program that never ran, and it is reported as one.
  const missing = stderr.startsWith(MISSING) ? stderr.slice(MISSING.length).trim() : undefined;
  // An expired deadline surfaces as an ETIMEDOUT error and the child is then
  // killed, so that error is the clock rather than a failure to launch: the
  // process ran, and only the deadline says otherwise.
  const timedOut = missing === undefined && spawnFailure?.code === "ETIMEDOUT";

  return {
    command: formatCommand(command, args),
    // A run stopped at its deadline never exited, so it has no exit status to
    // report: a consumer that reads the status alone would take a timeout for
    // a program that finished successfully.
    code: missing === undefined && !timedOut ? result.status : null,
    signal: missing === undefined ? result.signal : null,
    stdout: result.stdout ?? "",
    stderr: missing === undefined ? stderr : "",
    durationNs,
    timedOut,
    // Every spawn failure leaves status and signal null, which reads as a
    // clean exit to a consumer that only tests code. Report all of them, not
    // just a missing binary, so a process that never ran is never mistaken
    // for one that ran correctly.
    spawnError:
      missing !== undefined
        ? missing
        : timedOut || spawnFailure === undefined
          ? undefined
          : spawnFailure.code === "ENOENT"
            ? command
            : spawnFailure.message,
  };
}

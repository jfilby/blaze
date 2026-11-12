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

import { clearTimeout, hostBoundHeap, hostEnvironment, hostSpawn, hostSpawnSupport, monotonicTimeNs, spawnSync, type BoundedCommand, type HostError } from "./platform.ts";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: Readonly<Record<string, string | undefined>>;
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

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The heap a generated program is given, which is generous: it is meant to
 * stop a runaway allocation, not to ration a program that works.
 */
export const GENERATED_HEAP_BYTES = 2 * 1024 * 1024 * 1024;

export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const started = monotonicTimeNs();
  // The host decides how a bounded run is launched. What the result reports is
  // the command that was asked for, not the wrapper the host may have used to
  // start it.
  const spawned: BoundedCommand = options.heapBytes === undefined
    ? { command, args: [...args] }
    : hostBoundHeap(command, args, options.heapBytes);
  const result = spawnSync(spawned.command, spawned.args, {
    cwd: options.cwd,
    env: options.env ? { ...hostEnvironment(), ...options.env } : hostEnvironment(),
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    killSignal: KILL_SIGNAL,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
  });
  const durationNs = monotonicTimeNs() - started;
  const spawnFailure = result.error as NodeJS.ErrnoException | undefined;
  const stderr = result.stderr ?? "";
  // A host may reach the program through a wrapper, so a program that is not
  // there is the wrapper's exit status rather than a failure to spawn. It is
  // still a program that never ran, and it is reported as one.
  const missingPrefix = spawned.missing;
  const missing =
    missingPrefix !== undefined && stderr.startsWith(missingPrefix)
      ? stderr.slice(missingPrefix.length).trim()
      : undefined;
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

/**
 * The same run, awaited rather than waited on.
 *
 * `run` blocks the process it is called in, so a caller that has ten
 * independent programs to run runs them one after another whatever the machine
 * has cores to run. This is the same contract over a child process that does
 * not block: the same options, the same result, the same reading of a deadline
 * and of a program that was never there. What differs is only that the caller
 * can have several of them in flight, which is what the language and the
 * toolchain need to use more than one core.
 *
 * The deadline is enforced with the same signal, for the same reason: a run
 * that is asked to stop is a run that may not. A run whose output outgrows the
 * bound is stopped too, and reported as unable to be read rather than as a run
 * that finished, because the output a consumer needs is exactly what did not
 * fit.
 */
export function runAsync(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  // A host without an asynchronous child has one process primitive, the one
  // `run` uses: the children are run in order, and the answer is the answer
  // the blocking run gives.
  if (!hostSpawnSupport()) return Promise.resolve(run(command, args, options));
  const spawnChild = hostSpawn;
  const started = monotonicTimeNs();
  const spawned: BoundedCommand = options.heapBytes === undefined
    ? { command, args: [...args] }
    : hostBoundHeap(command, args, options.heapBytes);
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  const deadlineMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RunResult>((settle) => {
    const child = spawnChild(spawned.command, spawned.args, {
      cwd: options.cwd,
      env: options.env ? { ...hostEnvironment(), ...options.env } : hostEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let launchError: NodeJS.ErrnoException | undefined;
    let settled = false;

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const durationNs = monotonicTimeNs() - started;
      const missingPrefix = spawned.missing;
      const missing =
        missingPrefix !== undefined && stderr.startsWith(missingPrefix)
          ? stderr.slice(missingPrefix.length).trim()
          : undefined;
      const spawnFailure =
        launchError ??
        (overflowed
          ? ({ code: "ENOBUFS", message: `the run wrote more than ${maxBuffer} bytes` } as NodeJS.ErrnoException)
          : undefined);
      settle({
        command: formatCommand(command, args),
        code: missing === undefined && !timedOut ? status : null,
        signal: missing === undefined ? signal : null,
        stdout,
        stderr: missing === undefined ? stderr : "",
        durationNs,
        timedOut: missing === undefined && timedOut,
        spawnError:
          missing !== undefined
            ? missing
            : timedOut || spawnFailure === undefined
              ? undefined
              : spawnFailure.code === "ENOENT"
                ? command
                : spawnFailure.message,
      });
    };

    const stop = (): void => {
      child.kill(KILL_SIGNAL);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, deadlineMs));

    const gather = (into: "stdout" | "stderr", chunk: string): void => {
      if (into === "stdout") stdout += chunk;
      else stderr += chunk;
      if ((stdout.length > maxBuffer || stderr.length > maxBuffer) && !overflowed) {
        overflowed = true;
        stop();
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => gather("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => gather("stderr", chunk));

    child.on("error", (error: HostError) => {
      launchError = error as NodeJS.ErrnoException;
      // A child that never launched has no streams to drain and no exit to
      // wait for, so the answer is the failure itself.
      finish(null, null);
    });
    child.on("close", (status: number | null, signal: string | null) =>
      finish(status, signal as NodeJS.Signals | null),
    );
    // A run that ends before it read what was written to it is the run's answer,
    // not this process's: the pipe is closed under the write, and that is not the
    // thing that went wrong.
    child.stdin?.on("error", () => undefined);

    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

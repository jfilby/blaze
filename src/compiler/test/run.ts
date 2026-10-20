/**
 * The sectioned test runner.
 *
 * Runs the compiler test suite's sections concurrently through a bounded pool:
 * each section is a whole test file executed in its own node process by
 * node:test's `run()`. The sections' events are merged into a single TAP
 * document with one plan and one `# tests`/`# pass`/`# fail` summary, so the
 * suite's contract is unchanged:
 *
 *  * the optimizer reads `^# pass (\d+)$` and `^# fail (\d+)$` from the
 *    combined output (src/optimizer/cli.ts runTestSuite),
 *  * the process exits non-zero when any test fails,
 *  * the existing progress reporter (`--test-reporter=./test/reporter.ts`)
 *    still says how far the suite has got.
 *
 * The pool is bounded (default 8) so the suite cannot import the compiler in
 * more processes than the host's memory can hold.
 */

import { basename } from "node:path";
import { run } from "node:test";
import type { TestEvent } from "node:test/reporters";
import { pathToFileURL } from "node:url";
import { discoverSections, type Section } from "./sections.ts";

const DEFAULT_CONCURRENCY = 8;
const SUITE_FILE_SUFFIX = ".test.ts";

/** Diagnostic message keys that belong to a per-section summary, never the suite's. */
const SUMMARY_MESSAGE_KEYS = new Set([
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
  "duration_ms",
]);

/** A tiny unbounded channel so independently running sections stream their
 *  events to one consumer without a slow section blocking the fast ones. */
class Channel<T> {
  private queue: T[] = [];
  private waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.queue.push(item);
  }

  async pull(): Promise<T> {
    if (this.queue.length) return this.queue.shift()!;
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

/** An item travelling through the channel: a test event, or a control signal. */
type ChannelItem =
  | { kind: "event"; event: TestEvent }
  | { kind: "done"; section: Section }
  | { kind: "error"; section: Section };

interface ParsedArgs {
  reporter: string;
  concurrency: number;
  files: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    reporter: "./test/reporter.ts",
    concurrency: DEFAULT_CONCURRENCY,
    files: [],
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg.startsWith("--test-reporter=")) {
      args.reporter = arg.slice("--test-reporter=".length);
      index++;
    } else if (arg === "--test-reporter") {
      args.reporter = argv[++index];
      index++;
    } else if (arg.startsWith("--concurrency=")) {
      args.concurrency = Number(arg.slice("--concurrency=".length)) || DEFAULT_CONCURRENCY;
      index++;
    } else if (arg === "--concurrency") {
      args.concurrency = Number(argv[++index]) || DEFAULT_CONCURRENCY;
      index++;
    } else if (arg.endsWith(SUITE_FILE_SUFFIX)) {
      args.files.push(arg);
      index++;
    } else {
      index++;
    }
  }
  return args;
}

/** The default section stream: run one test file in its own process. */
export function defaultSectionStream(section: Section) {
  return run({
    files: [section.file],
    concurrency: 1,
    isolation: "process",
  });
}

/** A per-section event the suite-level reporter should not see. */
export function isSectionSummary(event: TestEvent): boolean {
  if (event.type === "test:plan" || event.type === "test:summary") {
    return true;
  }
  if (event.type === "test:diagnostic") {
    const data = event.data as { message?: unknown } | undefined;
    const message =
      data !== undefined && typeof data.message === "string" ? data.message : "";
    const key = message.split(" ")[0];
    return SUMMARY_MESSAGE_KEYS.has(key);
  }
  return false;
}

export async function* mergeSections(
  sections: readonly Section[],
  concurrency: number,
  totalTests: number,
  counts: {
    pass: number;
    fail: number;
    skip: number;
    todo: number;
    cancelled: number;
  },
  sectionStream: (section: Section) => AsyncIterable<TestEvent> = defaultSectionStream
): AsyncGenerator<TestEvent> {
  const channel = new Channel<ChannelItem>();
  let started = 0;
  const n = sections.length;

  const runTask = async (section: Section): Promise<void> => {
    try {
      for await (const event of sectionStream(section)) {
        channel.push({ kind: "event", event: event as TestEvent });
      }
    } catch {
      counts.cancelled++;
      channel.push({ kind: "error", section });
    } finally {
      if (started < n) spawnOne();
      channel.push({ kind: "done", section });
    }
  };

  const spawnOne = (): void => {
    if (started >= n) return;
    started++;
    runTask(sections[started - 1]);
  };

  for (let i = 0; i < concurrency; i++) spawnOne();

  // One plan for the whole suite, before any test result.
  yield {
    type: "test:plan",
    nesting: 0,
    data: { count: totalTests },
  } as unknown as TestEvent;

  const startTime = Date.now();
  let processedDone = 0;

  while (processedDone < n) {
    const item = await channel.pull();
    if (item.kind === "done") {
      processedDone++;
      continue;
    }
    if (item.kind === "error") {
      continue;
    }
    const ev = item.event;
    if (isSectionSummary(ev)) continue;
    const type = ev.type as string;
    if (type === "test:pass") counts.pass++;
    else if (type === "test:fail") counts.fail++;
    else if (type === "test:skip") counts.skip++;
    else if (type === "test:todo") counts.todo++;
    else if (type === "test:cancelled") counts.cancelled++;
    yield ev;
  }

  const total = counts.pass + counts.fail + counts.skip + counts.todo + counts.cancelled;
  // One aggregate summary for the whole suite.
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `tests ${total}` },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: "suites 0" },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `pass ${counts.pass}` },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `fail ${counts.fail}` },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `cancelled ${counts.cancelled}` },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `skipped ${counts.skip}` },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `todo ${counts.todo}` },
  } as unknown as TestEvent;
  yield {
    type: "test:diagnostic",
    nesting: 0,
    data: { message: `duration_ms ${Date.now() - startTime}` },
  } as unknown as TestEvent;
}

async function main(argv: readonly string[]): Promise<number> {
  const { reporter, concurrency, files } = parseArgs(argv);
  const { sections, totalTests } = await discoverSections(files);

  const reporterModule = await import(pathToFileURL(reporter).href);
  const { report: suiteReport } = reporterModule as {
    report: (
      source: AsyncIterable<TestEvent>,
      files: readonly string[]
    ) => AsyncGenerator<string>;
  };

  const suiteFiles = files.map((file) => basename(file));
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0 };

  const source = mergeSections(sections, concurrency, totalTests, counts);

  for await (const chunk of suiteReport(source, suiteFiles)) {
    process.stdout.write(chunk);
  }

  return counts.fail > 0 || counts.cancelled > 0 ? 1 : 0;
}

const code = await main(process.argv.slice(2));
process.exitCode = code;

/**
 * A test reporter that says how far the suite has got.
 *
 * The suite takes minutes, and whoever is watching it needs to know that it is
 * still going: a run that prints nothing for ten minutes reads as a run that
 * has stopped, and the agent that started it gives up on it. So the reporter
 * says how much of the suite is done, every tenth of it, over the suite's own
 * output, which is what it says it over.
 */

import { basename } from "node:path";
import { tap, type TestEvent } from "node:test/reporters";

/** The events a reporter is handed, as node hands them over. */
export type EventSource = AsyncIterable<TestEvent>;

/** The name every file of the suite carries, which is what tells a file from a test in it. */
const SUITE_FILE_SUFFIX = ".test.ts";

/**
 * The reporter the suite runs under.
 *
 * The files of the suite are the ones the command named, and the shell has
 * already spread them out for the reporter to read.
 */
export default async function* reporter(source: EventSource): AsyncGenerator<string> {
  yield* report(source, suiteFiles());
}

/**
 * The suite's own output, with how far the suite has got said over it.
 *
 * The suite's output is the tap reporter's, which is what the suite's summary
 * is read out of, so the progress is said over it rather than beside it.
 */
export async function* report(source: EventSource, files: readonly string[]): AsyncGenerator<string> {
  const progress = new SuiteProgress(files);
  for await (const chunk of tap(observe(source, progress))) {
    yield chunk;
    yield* progress.lines();
  }
  yield* progress.lines();
}

/** The events of the suite as they are handed over, with the progress read out of them. */
async function* observe(source: EventSource, progress: SuiteProgress): AsyncGenerator<TestEvent> {
  for await (const event of source) {
    if (event.type === "test:enqueue") progress.queued(basename(event.data.name));
    if (event.type === "test:complete") progress.finished(basename(event.data.name));
    yield event;
  }
}

/**
 * The files of the suite, as the command named them.
 *
 * The arguments of the command are the files themselves, because the shell
 * spread the suite's files out before node ever saw them.
 */
export function suiteFiles(argv: readonly string[] = process.argv): string[] {
  return argv
    .slice(1)
    .filter((argument) => argument.endsWith(SUITE_FILE_SUFFIX))
    .map((argument) => basename(argument));
}

/**
 * How much of the suite has run, and what is left to be said about it.
 *
 * The suite is a set of files, and a file is done when it has run to its end.
 * The share of the suite that is done is what the reporter says, every tenth
 * of it: a tenth is far enough apart to be worth a line of its own and close
 * enough together to say that the suite is still going.
 */
export class SuiteProgress {
  /** The files of the suite, by name. */
  private readonly files: readonly string[];
  /** The files that have run to their end. */
  private readonly doneFiles = new Set<string>();
  /** The files that have been queued to run. */
  private readonly queuedFiles = new Set<string>();
  /** The last share of the suite that has been said. */
  private said = 0;

  constructor(files: readonly string[] = suiteFiles()) {
    this.files = files;
  }

  /** A file of the suite has been queued to run. */
  public queued(name: string): void {
    if (this.isFile(name)) this.queuedFiles.add(name);
  }

  /** A file of the suite has run to its end. */
  public finished(name: string): void {
    if (this.isFile(name)) this.doneFiles.add(name);
  }

  /** The lines to say about how far the suite has got, if there are any to say. */
  public lines(): string[] {
    const total = this.total();
    if (total === 0) return [];
    const share = Math.floor((this.doneFiles.size / total) * 100);
    const lines: string[] = [];
    while (this.said + 10 <= share) {
      this.said += 10;
      lines.push(`# ${this.said}% complete\n`);
    }
    return lines;
  }

  /** How many files the suite has, as far as the reporter knows. */
  private total(): number {
    // The command named the files of the suite, so they are what it has. A
    // suite run without them named is counted as it queues them.
    return this.files.length > 0 ? this.files.length : this.queuedFiles.size;
  }

  /** Whether a name is a file of the suite rather than a test inside one. */
  private isFile(name: string): boolean {
    if (this.files.length === 0) return name.endsWith(SUITE_FILE_SUFFIX);
    return this.files.includes(name);
  }
}

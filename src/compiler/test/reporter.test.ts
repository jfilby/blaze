/**
 * What the suite's reporter says about how far the suite has got.
 *
 * The suite takes minutes, and whoever is watching it has to know that it is
 * still going: a run that says nothing for ten minutes reads as a run that has
 * stopped. So the reporter says how much of the suite is done, every tenth of
 * it, and it says it over the suite's own output rather than beside it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { TestEvent } from "node:test/reporters";
import { report, suiteFiles, type EventSource } from "./reporter.ts";

/** The events of a suite of files, as node hands them over. */
function events(files: readonly string[]): EventSource {
  return {
    async *[Symbol.asyncIterator]() {
      // The runner queues every file of the suite before it runs any of them,
      // so the whole of the suite is known before the first file is done.
      for (const file of files) {
        yield {
          type: "test:enqueue",
          data: { name: `test/${file}`, nesting: 0, type: "test" },
        } satisfies TestEvent;
      }
      for (const [index, file] of files.entries()) {
        yield {
          type: "test:pass",
          data: { name: `a test of ${file}`, nesting: 0, testNumber: index + 1, details: { duration_ms: 1 } },
        } satisfies TestEvent;
        yield {
          type: "test:complete",
          data: { name: `test/${file}`, nesting: 0, testNumber: index + 1, details: { passed: true, duration_ms: 1 } },
        } satisfies TestEvent;
      }
      for (const message of [`tests ${files.length}`, `pass ${files.length}`, "fail 0"]) {
        yield {
          type: "test:diagnostic",
          data: { message, nesting: 0, level: "info" },
        } satisfies TestEvent;
      }
    },
  };
}

/** Everything a reporter said, as one text. */
async function said(source: EventSource, files: readonly string[]): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of report(source, files)) chunks.push(chunk);
  return chunks.join("");
}

/** The files of a suite of a given size. */
function files(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `file${index}.test.ts`);
}

test("the suite says how far it has got, every tenth of it", async () => {
  const names = files(10);

  const output = await said(events(names), names);

  for (const tenth of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    assert.match(output, new RegExp(`^# ${tenth}% complete$`, "m"));
  }
});

test("the suite says nothing before it has gone a tenth further", async () => {
  const names = files(20);

  // One file of twenty is a twentieth of the suite, and not yet the tenth the
  // reporter speaks at: the first file says nothing, the second says a tenth.
  const first = await said(events(names.slice(0, 1)), names);
  assert.doesNotMatch(first, /% complete/);

  const second = await said(events(names.slice(0, 2)), names);
  assert.match(second, /^# 10% complete$/m);
  assert.doesNotMatch(second, /^# 20% complete$/m);
});

test("the suite's own output is still the suite's own output", async () => {
  const names = files(2);

  const output = await said(events(names), names);

  // The reporter speaks over the suite's output rather than instead of it:
  // what the suite says about its tests is still there to be read.
  assert.match(output, /^ok 1 - /m);
  assert.match(output, /^# pass \d+$/m);
});

test("the files of the suite are the ones the command named", () => {
  assert.deepEqual(suiteFiles(["node", "test/a.test.ts", "test/b.test.ts", "--flag"]), ["a.test.ts", "b.test.ts"]);
});

test("the suite runs under the reporter that says how far it has got", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: { test: string };
  };

  // The reporter is what says how far the suite has got, and it is said by the
  // suite's own command: a suite run without it says nothing until it is done.
  assert.match(manifest.scripts.test, /--test-reporter=\.\/test\/reporter\.ts/);
});

test("a suite run without its files named is counted as it queues them", async () => {
  const names = files(4);

  // The command named no files, so the reporter counts the ones it sees
  // queued: four files, and the suite is done when all four have run.
  const output = await said(events(names), []);

  assert.match(output, /^# 100% complete$/m);
  assert.equal(output.match(/% complete/g)?.length, 10);
});

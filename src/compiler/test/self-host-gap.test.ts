/**
 * The self-host report measures the linked module graph, not each file alone.
 *
 * A file read on its own is refused for every construct that is only waiting
 * for an import to be bound: a value another file exports, a type another file
 * declares, a list a linked signature fills. Reading the graph a build reads is
 * what tells the two apart, so these tests pin the difference: a construct that
 * only needed the link is cleaned, and a construct outside the subset stays
 * refused whether or not anything imports the file that writes it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratch } from "./scratch.ts";
import { selfHostGap } from "./self-host-gap.ts";

/** Writes the sources of one measured tree and answers its directory. */
async function tree(files: Record<string, string>): Promise<string> {
  const directory = await scratch("blaze-self-host-gap-");
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source, "utf8");
  return directory;
}

test("a construct that only waited for an import is read once the graph links it", async () => {
  const directory = await tree({
    "lib.ts": "export const TABLE = { a: 1, b: 2 };\n",
    "cli.ts": [
      'import { TABLE } from "./lib.ts";',
      "",
      "export function sum(): number {",
      "  let total = 0;",
      "  for (const value of Object.values(TABLE)) total += value;",
      "  return total;",
      "}",
      "",
    ].join("\n"),
  });

  const report = await selfHostGap(directory);
  // On its own, `Object.values(TABLE)` is a value no read can name. The linked
  // read binds the export and reads the loop whole.
  assert.deepEqual(report.files, ["cli.ts", "lib.ts"], "the tree is measured by its own paths");
  assert.deepEqual(report.refused, [], "the link resolves what the standalone read could not");
  assert.deepEqual(report.clean, ["cli.ts", "lib.ts"]);
  assert.equal(report.total, 0);
});

test("a construct outside the subset is refused after the link, whoever imports it", async () => {
  const directory = await tree({
    "lib.ts": "export const TABLE = { a: 1, b: 2 };\n",
    "cli.ts": [
      'import { TABLE } from "./lib.ts";',
      "",
      "export function sum(): number {",
      "  const day = new Date();",
      "  let total = 0;",
      "  for (const value of Object.values(TABLE)) total += value;",
      "  return total + day.getTime();",
      "}",
      "",
    ].join("\n"),
    "orphan.ts": "export function stamp(): number {\n  return new Date().getTime();\n}\n",
  });

  const report = await selfHostGap(directory);
  // Every source is a root, so a file no import reaches is still measured.
  assert.deepEqual(report.files, ["cli.ts", "lib.ts", "orphan.ts"]);
  const refused = report.refused.map((one) => one.path);
  assert.deepEqual(refused, ["cli.ts", "orphan.ts"], "the link does not hide a construct the frontend does not read");
  for (const source of report.refused) {
    assert.ok(
      source.messages.some((message) => message.includes("Date")),
      `${source.path} names the construct it refused`,
    );
  }
});

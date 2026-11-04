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

test("a refused module still offers the signatures of what it exports", async () => {
  const directory = await tree({
    "lib.ts": [
      "export type Outcome = { refused: string } | { applied: number };",
      "export function apply(n: number): Outcome {",
      "  const stamp = new Date().getTime();",
      "  return n > 0 ? { applied: n + stamp } : { refused: `no` };",
      "}",
      "",
    ].join("\n"),
    "cli.ts": [
      'import { apply } from "./lib.ts";',
      "export function run(n: number): number {",
      "  const outcome = apply(n);",
      '  if ("refused" in outcome) return 0;',
      "  return outcome.applied;",
      "}",
      "",
    ].join("\n"),
  });

  const report = await selfHostGap(directory);
  // The module that writes the function is refused, so a build stops there.
  // The *signature* is not refused: the file that calls it is read against the
  // parameters and result the declaration writes, and that file's queue is
  // what the report measures.
  assert.deepEqual(report.clean, ["cli.ts"], "the caller's calls are read through the signature");
  assert.deepEqual(report.refused.map((one) => one.path), ["lib.ts"]);
});

test("a type a module re-exports is the declaration its own import binds", async () => {
  const directory = await tree({
    "ir.ts": [
      "export interface Body { symbol: string }",
      "export interface Program { bodies: Body[] }",
      "",
    ].join("\n"),
    "resolve.ts": 'import type { Program } from "./ir.ts";\nexport type { Program };\n',
    "driver.ts": [
      'import type { Program } from "./resolve.ts";',
      "",
      "export function symbols(program: Program): string[] {",
      "  return program.bodies.map((body) => body.symbol);",
      "}",
      "",
    ].join("\n"),
    "cli.ts": 'import { symbols } from "./driver.ts";\n',
  });

  const report = await selfHostGap(directory);
  // The re-exporting module writes no declaration: `Program` is the type its
  // own import bound, and the fields resolve in the module that wrote them. The
  // list field is read as the list it is, so `map` is a list's method and not a
  // method of the opaque reference the contract spells.
  assert.deepEqual(report.clean, ["cli.ts", "driver.ts", "ir.ts", "resolve.ts"]);
  assert.equal(report.total, 0);
});

test("a module that re-exports a name offers the declaration the other module wrote", async () => {
  const directory = await tree({
    "impl.ts": "export function readText(path: string): string {\n  return path;\n}\n",
    "platform.ts": 'export { readText } from "./impl.ts";\n',
    "cli.ts": [
      'import { readText } from "./platform.ts";',
      "export function trimmed(path: string): string {",
      "  return readText(path).trim();",
      "}",
      "",
    ].join("\n"),
  });

  const report = await selfHostGap(directory);
  // The re-exporting module compiles nothing: what it offers is another
  // module's name, and the signature a caller reads is the one that module
  // wrote. Without the follow the call would answer `any`, and `trim` would be
  // a method of nothing.
  assert.deepEqual(report.clean, ["cli.ts", "impl.ts", "platform.ts"]);
  assert.equal(report.total, 0);
});

test("an exported constant another module builds is read at the type it declares", async () => {
  const directory = await tree({
    "lib.ts": [
      "export interface Entry { name: string; size: number }",
      "function entry(name: string, size: number): Entry { return { name, size }; }",
      "export const TABLE: readonly Entry[] = [entry(`a`, 1), entry(`b`, 2)];",
      "",
    ].join("\n"),
    "cli.ts": [
      'import { TABLE } from "./lib.ts";',
      "export function total(): number {",
      "  return TABLE.map((one) => one.size).length;",
      "}",
      "",
    ].join("\n"),
  });

  const report = await selfHostGap(directory);
  // The table is built by calls, so the module holds it rather than writing it
  // out; what crosses the link is the type the declaration states, which is
  // what says the list's elements are records.
  assert.deepEqual(report.clean, ["cli.ts", "lib.ts"]);
  assert.equal(report.total, 0);
});

test("a callback parameter is typed by the imported signature", async () => {
  // `walk(values, (one) => ...)` hands `one` the type the declaration states
  // for its callback. The parameter is a function type, which no contract type
  // spells, so the shape the signature keeps travels the link beside the types:
  // without it `one` is a value of no type and a method on its field is refused.
  const directory = await tree({
    "lib.ts": [
      "export interface Shape { name: string }",
      "export function walk(values: Shape[], visit: (one: Shape) => void): void {",
      "  for (const value of values) visit(value);",
      "}",
      "",
    ].join("\n"),
    "cli.ts": [
      'import { walk } from "./lib.ts";',
      "export function names(values: { name: string }[]): number {",
      "  let letters = 0;",
      "  walk(values, (one) => {",
      "    letters += one.name.trim().length;",
      "  });",
      "  return letters;",
      "}",
      "",
    ].join("\n"),
  });
  const report = await selfHostGap(directory);
  assert.deepEqual(report.refused, [], "the imported callback signature types the arrow's parameter");
});

test("a class a type-only import names, and a class a module re-exports, cross the link", async () => {
  // `import type { Logger }` names a class the file reads through a value it
  // is handed: the methods written on that value are the class's. A module that
  // re-exports the class offers the declaration the module that wrote it holds.
  const directory = await tree({
    "lib.ts": [
      "export class Logger {",
      "  write(text: string): void {}",
      "}",
      "",
    ].join("\n"),
    "middle.ts": 'export { Logger } from "./lib.ts";\n',
    "cli.ts": [
      'import type { Logger } from "./lib.ts";',
      'import { Logger as Shared } from "./middle.ts";',
      "export function both(one: Logger, two: Shared): void {",
      '  one.write("a");',
      '  two.write("b");',
      "}",
      "",
    ].join("\n"),
  });
  const report = await selfHostGap(directory);
  assert.deepEqual(report.refused, [], "the class description crosses a type-only import and a re-export");
});

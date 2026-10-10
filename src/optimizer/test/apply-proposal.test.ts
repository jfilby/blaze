/**
 * What a proposal does to a file, and what it is not allowed to do.
 *
 * A proposal is applied verbatim: the text a model answered with becomes
 * the compiler's source. Every way one can be wrong is a way the source can
 * be corrupted, so each of them is refused here by name rather than written
 * and hoped over — a path that leaves the compiler, a match that is not the
 * one the answer was looking at, and the test suite a pass is judged by.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyProposal, readCompilerSource, type Proposal } from "../ai.ts";
import { scratch } from "./scratch.ts";

/** A compiler directory holding one file with text that appears once. */
async function fakeCompiler(): Promise<{ dir: string; file: string }> {
  const dir = await scratch("blazeopt-apply-");
  const file = join(dir, "compiler.ts");
  await writeFile(
    file,
    ["import { readFile } from \"node:fs/promises\";", "const MARKER = \"only once\";", ""].join("\n"),
  );
  return { dir, file };
}

/** The text of a file, for reading back what a proposal wrote. */
function textOf(path: string): Promise<string> {
  return readFile(path, "utf8");
}

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  file: "compiler.ts",
  description: "a change that can be applied",
  original: "const MARKER = \"only once\";",
  replacement: "const MARKER = \"changed\";",
  ...over,
});

test("a unique match is written", async () => {
  const { dir, file } = await fakeCompiler();

  assert.deepEqual(applyProposal(proposal(), dir), { kind: "applied", path: "compiler.ts" });
  assert.match(await textOf(file), /const MARKER = "changed";/);
});

test("a text that appears more than once is refused, not written in the first place", async () => {
  const dir = await scratch("blazeopt-apply-");
  const file = join(dir, "compiler.ts");
  // This compiler repeats its own scaffolding: the same line is written in
  // more than one place, and the first of them is not necessarily the one
  // the answer was looking at.
  await writeFile(file, ["const PAD = 1;", "code();", "const PAD = 2;"].join("\n"));
  const before = await textOf(file);

  assert.deepEqual(
    applyProposal(proposal({ original: "const PAD = ", replacement: "const GAP = " }), dir),
    { kind: "ambiguous" },
  );
  assert.equal(await textOf(file), before);
});

test("a text that is not there is refused", async () => {
  const { dir, file } = await fakeCompiler();

  assert.deepEqual(applyProposal(proposal({ original: "nothing like this exists" }), dir), {
    kind: "not-found",
  });
  assert.match(await textOf(file), /only once/);
});

test("replacing a text with itself changes nothing", async () => {
  const { dir, file } = await fakeCompiler();
  const before = await textOf(file);

  assert.deepEqual(applyProposal(proposal({ replacement: proposal().original }), dir), {
    kind: "unchanged",
  });
  assert.equal(await textOf(file), before);
});

test("a file outside the compiler is refused, not written", async () => {
  const { dir } = await fakeCompiler();
  // The compiler directory itself is not a file to write into either.
  const outside = ["../outside.ts", "/tmp/an-absolute-path.ts", "", "a\0b", join(dir, "..")];

  for (const file of outside) {
    assert.deepEqual(applyProposal(proposal({ file }), dir).kind, "outside-compiler", file);
  }
});

test("a test file is refused: it is the gate a pass is judged by", async () => {
  const dir = await scratch("blazeopt-apply-");
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(join(dir, "test", "ir.test.ts"), "test('x', () => {});\n");

  for (const file of ["test/ir.test.ts", "test/nested/ir.test.ts", "semantics/repair.test.ts"]) {
    assert.deepEqual(applyProposal(proposal({ file }), dir).kind, "test-file", file);
  }
});

test("the compiler source is read from the directory it is given", async () => {
  const dir = await scratch("blazeopt-apply-");
  await mkdir(join(dir, "semantics"), { recursive: true });
  await writeFile(join(dir, "compiler.ts"), "// one\n".repeat(10));
  await writeFile(join(dir, "semantics", "repair.ts"), "// two\n".repeat(10));

  const read = readCompilerSource(dir);

  assert.match(read, /\/\/ === compiler.ts ===/);
  assert.match(read, /\/\/ === semantics\/repair.ts ===/);
  // A file the directory does not hold is left out rather than an error.
  assert.doesNotMatch(read, /codegen\.ts/);
});

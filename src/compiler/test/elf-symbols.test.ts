/**
 * What an object says it defines, read out of the object.
 *
 * Every object the machine backend writes is inspected before it is linked: it
 * must define exactly the symbol it is called by and refer only to what
 * something else defines. That check is the last thing between a candidate and a
 * link failure, so what reads it must agree with the tool that used to be asked —
 * `nm` — down to which symbols count as defined and which as external. These
 * tests put real objects through both and compare.
 *
 * What a symbol table holds is not always the whole answer: a slim LTO object
 * keeps its symbols in the intermediate form and leaves a marker behind, which is
 * why the C backend's objects are still inspected by `nm`, whose plugin reads
 * that form. The last test is that difference, so that reading the file directly
 * is not put where it cannot answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./scratch.ts";
import { run } from "../core/process.ts";
import { objectSymbols } from "../toolchain/elf64.ts";

/** The two lists `nm` answers with, in the order it prints them. */
function nmSays(objectPath: string): { defined: string[]; undefined: string[] } {
  const defined = run("nm", ["--defined-only", "--extern-only", objectPath], { timeoutMs: 30_000 });
  const undefinedSymbols = run("nm", ["--undefined-only", objectPath], { timeoutMs: 30_000 });
  assert.equal(defined.code, 0, defined.stderr);
  assert.equal(undefinedSymbols.code, 0, undefinedSymbols.stderr);
  const names = (stdout: string): string[] =>
    stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).pop() ?? "")
      .filter((symbol) => symbol !== "");
  return { defined: names(defined.stdout), undefined: names(undefinedSymbols.stdout) };
}

const sorted = (symbols: readonly string[]): string[] => [...symbols].sort();

/** Asserts that reading the object and asking `nm` are the same answer. */
function assertAgreesWithNm(objectPath: string): void {
  const read = objectSymbols(new Uint8Array(readFileSync(objectPath)));
  const asked = nmSays(objectPath);
  assert.deepEqual(sorted(read.defined), sorted(asked.defined), "the defined symbols are nm's");
  assert.deepEqual(sorted(read.undefined), sorted(asked.undefined), "the undefined symbols are nm's");
}

/** A C translation unit with every kind of symbol a candidate can carry. */
const C_SOURCE = [
  "#include <stdio.h>",
  "",
  "int blaze_exported_data = 7;",
  "static int hidden_data = 9;",
  "",
  "static int helper(int value) {",
  "  return value + hidden_data;",
  "}",
  "",
  "__attribute__((weak)) int blaze_weak(int value) {",
  "  return value - 1;",
  "}",
  "",
  "int blaze_exported(int value) {",
  "  printf(\"%d\\n\", value);",
  "  return helper(value) + blaze_weak(value) + blaze_exported_data;",
  "}",
  "",
].join("\n");

const ASSEMBLY = [
  ".text",
  ".globl candidate",
  ".type candidate, @function",
  "candidate:",
  "  push %rbp",
  "  mov %rsp, %rbp",
  // A local label is the object's own business, and every assembler writes one
  // for a jump it resolves itself.
  ".Llocal:",
  "  call blaze_rt_allocate",
  "  pop %rbp",
  "  ret",
  ".size candidate, .-candidate",
  ".section .note.GNU-stack,\"\",@progbits",
  "",
].join("\n");

test("the symbols read out of a compiled object are the ones nm reports", async () => {
  const directory = await scratch("blaze-elf-symbols-c-");
  const source = join(directory, "unit.c");
  const object = join(directory, "unit.o");
  writeFileSync(source, C_SOURCE, "utf8");
  const compiled = run("gcc", ["-std=c11", "-O0", "-c", "-o", object, source], { timeoutMs: 120_000 });
  assert.equal(compiled.code, 0, compiled.stderr);

  assertAgreesWithNm(object);
  // A sanity check on the fixture itself: the object carries all three of the
  // kinds this has to tell apart, so agreeing with `nm` is agreement about them.
  const read = objectSymbols(new Uint8Array(readFileSync(object)));
  assert.ok(read.defined.includes("blaze_exported"));
  assert.ok(read.defined.includes("blaze_exported_data"));
  assert.ok(read.defined.includes("blaze_weak"));
  assert.ok(!read.defined.includes("helper"), "a static function is not a symbol another object links against");
  assert.ok(!read.defined.includes("hidden_data"), "a static variable is not one either");
  assert.ok(read.undefined.includes("printf"));
});

test("the symbols read out of an assembled object are the ones nm reports", async () => {
  const directory = await scratch("blaze-elf-symbols-asm-");
  const source = join(directory, "candidate.s");
  const object = join(directory, "candidate.o");
  writeFileSync(source, ASSEMBLY, "utf8");
  const assembled = run("as", ["--64", "-o", object, source], { timeoutMs: 60_000 });
  assert.equal(assembled.code, 0, assembled.stderr);

  assertAgreesWithNm(object);
  const read = objectSymbols(new Uint8Array(readFileSync(object)));
  assert.deepEqual(read.defined, ["candidate"]);
  assert.deepEqual(read.undefined, ["blaze_rt_allocate"]);
});

test("a slim LTO object keeps its symbols out of the object, and says so with a marker", async () => {
  // The C backend compiles a candidate with `-flto`, which writes the
  // intermediate form rather than machine code and leaves `__gnu_lto_slim` where
  // the symbols would be. `nm` reads them out of that form through its plugin;
  // an object read as an object has only the marker, which is why the C
  // backend's objects are still inspected by `nm` and the machine backend's own
  // are read here.
  const directory = await scratch("blaze-elf-symbols-lto-");
  const source = join(directory, "unit.c");
  const object = join(directory, "unit.o");
  writeFileSync(source, C_SOURCE, "utf8");
  const compiled = run("gcc", ["-std=c11", "-O2", "-flto", "-c", "-o", object, source], { timeoutMs: 120_000 });
  assert.equal(compiled.code, 0, compiled.stderr);

  const read = objectSymbols(new Uint8Array(readFileSync(object)));
  assert.ok(!read.defined.includes("blaze_exported"), "the function is not in the object's symbol table");
  assert.ok(read.defined.includes("__gnu_lto_slim"), "the marker that says where the symbols are is");
});

test("a file that is not an object is reported as one, rather than read as an empty one", async () => {
  const directory = await scratch("blaze-elf-symbols-none-");
  const path = join(directory, "not-an-object.o");
  writeFileSync(path, "this is not an ELF object\n", "utf8");
  assert.throws(() => objectSymbols(new Uint8Array(readFileSync(path))), /not an ELF object/);
});

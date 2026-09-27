/**
 * What the prompt tells the model.
 *
 * A prompt is a contract with the model, and the rules in it are the rules the
 * toolchain enforces afterwards. These tests state the ones whose absence costs
 * an attempt: the symbol to define, the labels and calls a candidate may write,
 * the registers it has to preserve, and what a candidate is checked against.
 * They match the facts rather than the sentences, so rewording the prompt does
 * not break them and a dropped rule does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildSystemPrompt, buildUserPrompt, type PromptRequest } from "../ai/prompt.ts";
import { CompilerError } from "../core/errors.ts";
import { validateAssembly } from "../toolchain/assembler.ts";
import { programOf } from "./phase.ts";
import type { FunctionContract } from "../core/types.ts";

const EXAMPLE = "/jason/My_Development/blaze/src/examples";

/** A program with three functions: an entry, one that recurses, one that builds. */
const TREES = {
  "1.ts": readFileSync(`${EXAMPLE}/binarytrees/1.ts`, "utf8"),
};

const LIBRARY = {
  "hello_world.ts": readFileSync(`${EXAMPLE}/hello_world/hello_world.ts`, "utf8"),
};

function request(overrides: Partial<PromptRequest> & Pick<PromptRequest, "contract" | "unit" | "program" | "sources">): PromptRequest {
  return {
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "machine",
    runtime: "none",
    candidate: 1,
    candidates: 1,
    attempt: 1,
    ...overrides,
  };
}

const treeProgram = programOf("typescript", TREES, "1.ts");
const treeMain = treeProgram.files[0].functions.main;
const treeChecksum = treeProgram.files[0].functions.checksum;

test("the prompt names the symbol the assembler will accept", () => {
  const prompt = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program: treeProgram, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  // The C prototype of a program entry is not the symbol: the entry is
  // compiled as blaze_main, and `.globl main` is rejected.
  assert.match(prompt, /C prototype: void main\(\)/);
  assert.match(prompt, /label: blaze_main:/);
  assert.match(prompt, /\.global blaze_main/);
  assert.doesNotMatch(prompt, /label: main:/);
});

test("the prompt states the labels and the calls a candidate may write", () => {
  const prompt = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program: treeProgram, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  // Each of these is a rejection in assembler.ts, and none of them is obvious
  // from a program whose source calls its own functions.
  assert.match(prompt, /Every other label you define must start with a dot/);
  assert.match(prompt, /for recursion/);
  // Without the sibling contracts there is nothing to call, so the prompt says
  // what it may reference rather than naming functions it was not handed.
  assert.match(prompt, /The only symbols you may reference are "blaze_main" itself, for recursion, and the runtime ABI/);
  assert.match(prompt, /This function is the only one this build compiles/);
});

test("a candidate is told the functions of the program it may call, and how", () => {
  const prompt = buildUserPrompt(
    request({
      contract: treeMain,
      unit: { file: "1.ts", function: "main" },
      program: treeProgram,
      sources: [{ path: "1.ts", source: TREES["1.ts"] }],
      callees: [treeChecksum, treeProgram.files[0].functions.createTree],
    }),
  );

  // The model is told the call, the symbol to make it on, and where the
  // arguments and the result go, because those are what a call is written from
  // and none of them can be read off the TypeScript it was given.
  assert.match(prompt, /FUNCTIONS YOU MAY CALL/);
  assert.match(prompt, /"checksum", "createTree"/);
  assert.match(prompt, /C prototype: double checksum\(void\* node\)/);
  assert.match(prompt, /argument locations: node -> rdi/);
  assert.match(prompt, /return value: xmm0/);
  assert.match(prompt, /call it instead of writing out/);
  // The entry is excluded: a candidate is already the implementation of it.
  assert.doesNotMatch(prompt, /C prototype: void blaze_main/);
  assert.doesNotMatch(prompt, /Calling another function of this program is rejected/);
});

test("the prompt states what the function owes the convention it is called under", () => {
  const prompt = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program: treeProgram, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  assert.match(prompt, /preserve rbx, rbp and r12 to r15/);
  assert.match(prompt, /return with ret/);
  // The return address is still on the stack, so the boundary a candidate has
  // to keep is not the one it arrives on. Stating it as if it were is what let
  // a candidate allocate a multiple of 16 and fault every call it made.
  assert.match(prompt, /rsp is 8 past a 16-byte boundary/);
  assert.match(prompt, /a multiple of 16 plus 8/);
  // The harness declares the function in C, so the result is read back by the
  // C convention: xmm0 for a floating point return, rax for anything else.
  assert.match(prompt, /return value: xmm0/);
});

test("the program the model writes is the one the assembler is given", () => {
  // The rules the prompt states have to be the ones the validator enforces, or
  // they are decoration: this is the shape each of them rejects, and what it
  // says about it.
  const rejected = (assembly: string, contract: FunctionContract, callable?: ReadonlySet<string>): string => {
    try {
      validateAssembly(assembly, contract, undefined, callable);
    } catch (error) {
      if (!(error instanceof CompilerError)) return String(error);
      return error.detail ?? error.message;
    }
    return "";
  };

  assert.match(rejected(["\t.globl\tmain", "main:", "\tret", ""].join("\n"), treeMain), /only "blaze_main" may be exported/);
  assert.match(rejected(["\t.globl\tchecksum", "checksum:", "loop:", "\tret", ""].join("\n"), treeChecksum), /the contract only allows "checksum"/);
  // A symbol that is neither the runtime, nor this function, nor another
  // function of the build is still turned away: the program is what a
  // candidate may reach outside itself for.
  assert.match(rejected(["\t.globl\tblaze_main", "blaze_main:", "\tcall\thelper", "\tret", ""].join("\n"), treeMain), /may only call the runtime ABI and the other functions of this program/);
  // A function of the same program is a call the build links, not a rejection.
  // The frame it is made from is still a legal one: the rule about alignment is
  // about the call, not about who is being called.
  assert.equal(rejected(["\t.globl\tblaze_main", "blaze_main:", "\tsubq\t$24, %rsp", "\tcall\tchecksum", "\taddq\t$24, %rsp", "\tret", ""].join("\n"), treeMain, new Set(["checksum"])), "");
  // And it is only a call because the build compiles it: the same symbol in a
  // build that does not compile checksum is not one.
  assert.match(rejected(["\t.globl\tblaze_main", "blaze_main:", "\tsubq\t$24, %rsp", "\tcall\tchecksum", "\taddq\t$24, %rsp", "\tret", ""].join("\n"), treeMain), /"checksum" is referenced but not defined/);
  // Recursion into its own symbol is the one call a candidate may make. It is
  // made from a frame the call itself put on the stack, which is what puts rsp
  // back on a boundary for the runtime it calls.
  assert.doesNotThrow(() =>
    validateAssembly(
      ["\t.globl\tchecksum", "checksum:", "\tpushq\t%rbp", "\tcall\tchecksum", "\tpopq\t%rbp", "\tret", ""].join("\n"),
      treeChecksum,
    ),
  );
  assert.match(
    rejected(["\t.globl\tchecksum", "checksum:", "\tsubq\t$16, %rsp", "\tcall\tchecksum", "\taddq\t$16, %rsp", "\tret", ""].join("\n"), treeChecksum),
    /is made with rsp 8 byte\(s\) off a 16-byte boundary/,
  );
});

test("a function that states what it does is told how it is checked", () => {
  const prompt = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program: treeProgram, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  // Nothing runs such a function on its own, so the program is the oracle, and
  // its output is the specification the model has to hit character for character.
  assert.match(prompt, /compares what it prints with what the source/);
  assert.match(prompt, /blaze_rt_print_number and never format one yourself/);
  assert.match(prompt, /70, not\n? ?70\.0/);
  // A definition contract carries no memory ranges and no numeric policy, and
  // stating the empty ones would claim the function reads nothing.
  assert.doesNotMatch(prompt, /MEMORY REQUIREMENTS/);
  assert.doesNotMatch(prompt, /NUMERICAL SEMANTICS/);
  assert.match(prompt, /A number in the source is a double/);
});

test("a contract that states a result keeps the memory and numeric sections", () => {
  const program = programOf("typescript", LIBRARY, "hello_world.ts", { entry: "dotProduct" });
  const contract = program.files[0].functions.dotProduct;
  const prompt = buildUserPrompt(
    request({ contract, unit: { file: "hello_world.ts", function: "dotProduct" }, program, sources: [{ path: "hello_world.ts", source: LIBRARY["hello_world.ts"] }] }),
  );

  assert.match(prompt, /result == sum\(i = 0\.\.<n/);
  assert.match(prompt, /reads: a\[0:n\], b\[0:n\]/);
  assert.match(prompt, /NUMERICAL SEMANTICS/);
  // A buffer arrives as a bare pointer; the length is one of the parameters,
  // which is what the precondition len(a) >= n is about.
  assert.match(prompt, /a bare pointer to the first element/);
});

test("the target says which instructions the machine has", () => {
  const program = programOf("typescript", TREES, "1.ts");
  const prompt = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  assert.match(prompt, /instruction set: the x86_64 baseline, and nothing wider/);
  assert.match(prompt, /architecture: x86_64/);

  const wide = buildUserPrompt(
    request({
      contract: treeChecksum,
      unit: { file: "1.ts", function: "checksum" },
      program,
      sources: [{ path: "1.ts", source: TREES["1.ts"] }],
      target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: ["avx2"] },
    }),
  );
  assert.match(wide, /instruction set: avx2/);
});

test("the effects of the source and the prohibition on the implementation are not the same rule", () => {
  const program = programOf("typescript", TREES, "1.ts");
  const printing = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );
  assert.match(printing, /the source function: io, syscall/);
  assert.match(printing, /reached through the runtime ABI above and never directly/);

  const pure = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );
  assert.match(pure, /none: the source function touches nothing outside its arguments/);
});

test("a second candidate is told what makes it worth a request", () => {
  const program = programOf("typescript", TREES, "1.ts");
  const sources = [{ path: "1.ts", source: TREES["1.ts"] }];
  const first = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, sources }),
  );
  const second = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, sources, candidate: 2, candidates: 2 }),
  );

  assert.doesNotMatch(first, /only worth its request/);
  assert.match(second, /candidate 2 of 2/);
  assert.match(second, /only worth its request if it takes a/);
});

test("the runtime section offers the entry points a candidate can reach", () => {
  const program = programOf("typescript", TREES, "1.ts");
  const sources = [{ path: "1.ts", source: TREES["1.ts"] }];
  // `main` allocates nothing itself, but it may inline `createTree`, which
  // does, so the object allocator has to be in reach of both.
  const entry = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program, sources }),
  );
  assert.match(entry, /blaze_rt_object_new/);
  assert.match(entry, /blaze_rt_print_number/);
  // The host calls these, so a candidate is never told about them.
  assert.doesNotMatch(entry, /blaze_rt_initialize/);
  assert.doesNotMatch(entry, /blaze_rt_arguments_set/);

  // A library function states a result and not how it is done, so it may take
  // a working copy; a program function that touches nothing may not.
  const library = programOf("typescript", LIBRARY, "hello_world.ts", { entry: "dotProduct" });
  const dot = buildUserPrompt(
    request({ contract: library.files[0].functions.dotProduct, unit: { file: "hello_world.ts", function: "dotProduct" }, program: library, sources: [{ path: "hello_world.ts", source: LIBRARY["hello_world.ts"] }] }),
  );
  assert.match(dot, /blaze_rt_allocate/);
  assert.doesNotMatch(dot, /blaze_rt_print_number/);
});

test("the system prompt describes the build the model is in", () => {
  const native = buildSystemPrompt("machine");
  assert.match(native, /architecture prelude, the harness, the host and the build are compiler/);
  assert.doesNotMatch(buildSystemPrompt("wasm"), /architecture prelude/);
  assert.match(buildSystemPrompt("wasm"), /WebAssembly|output language/);
});

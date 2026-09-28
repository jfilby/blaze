/**
 * What the prompt tells the model.
 *
 * A prompt is a contract with the model, and the rules in it are the rules the
 * toolchain enforces afterwards. These tests state the ones whose absence costs
 * an attempt: the symbol the answer is written as, the calls a candidate may
 * write, and what a candidate is checked against. A register, a stack offset
 * and a calling convention are the compiler's once the answer is IR, so no
 * test here states one. They match the facts rather than the sentences, so
 * rewording the prompt does not break them and a dropped rule does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildSystemPrompt, buildUserPrompt, type PromptRequest } from "../ai/prompt.ts";
import { CompilerError } from "../core/errors.ts";
import { validateAssembly } from "../toolchain/assembler.ts";
import { programWithSemantics } from "./phase.ts";
import type { FunctionContract } from "../core/types.ts";

const EXAMPLE = "/jason/My_Development/blaze/src/examples";

/** A program with three functions: an entry, one that recurses, one that builds. */
const TREES = {
  "1.ts": readFileSync(`${EXAMPLE}/binarytrees/1.ts`, "utf8"),
};

const LIBRARY = {
  "hello_world.ts": readFileSync(`${EXAMPLE}/hello_world/hello_world.ts`, "utf8"),
};

function request(
  overrides: Partial<PromptRequest> &
    Pick<PromptRequest, "contract" | "unit" | "program" | "sources" | "semantics">,
): PromptRequest {
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

const tree = programWithSemantics("typescript", TREES, "1.ts");
const treeProgram = tree.program;
const treeSemantics = tree.semantics;
const treeMain = treeProgram.files[0].functions.main;
const treeChecksum = treeProgram.files[0].functions.checksum;

test("the prompt names the entry by the symbol it is linked as, not by its name", () => {
  const prompt = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program: treeProgram, semantics: treeSemantics, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  // The function the entry is contracted as is `main` and the symbol the build
  // links it under is `blaze_main`, so the answer is the latter: the IR names
  // a function as the symbol it is compiled to, and a candidate that wrote
  // `main` would be linked as a second entry.
  assert.match(prompt, /"name": "main"/);
  assert.match(prompt, /"symbol": "blaze_main"/);
  assert.match(prompt, /^function to implement: blaze_main$/m);
  assert.doesNotMatch(prompt, /function to implement: main\b/);
});

test("the prompt states the calls a candidate may write, and no more names than those", () => {
  const prompt = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program: treeProgram, semantics: treeSemantics, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  // `main` calls two other functions of the program and writes neither of them
  // out, so both are offered as a name and its contract, and nothing is offered
  // as a body. It used to claim the opposite, because the symbols came from a
  // list the caller had to remember to pass rather than from the calls the
  // contract records.
  assert.match(prompt, /^CALLS$/m);
  assert.match(prompt, /^createTree\(depth: f64\) -> ref<Object1>$/m);
  assert.match(prompt, /^checksum\(node: ref<any>\) -> f64$/m);
  assert.doesNotMatch(prompt, /^WRITE OUT$/m);
  // A name outside that list is refused whatever it is called, because the IR
  // is read back against the contract and a callee name is part of it.
  assert.match(prompt, /the callee names are the contract's, and the compiler refuses a candidate that disagrees/);
});

test("a candidate is told the functions of the program it may call, and the contract each is called under", () => {
  const prompt = buildUserPrompt(
    request({
      contract: treeMain,
      unit: { file: "1.ts", function: "main" },
      program: treeProgram,
      semantics: treeSemantics,
      sources: [{ path: "1.ts", source: TREES["1.ts"] }],
    }),
  );
  // The model is told the call and what it must satisfy, because a `call` in
  // the answer is read back against the callee's contract and none of it can
  // be read off the TypeScript the candidate was given.
  assert.match(prompt, /^CALLS$/m);
  assert.match(prompt, /^createTree\(depth: f64\) -> ref<Object1>$/m);
  assert.match(prompt, /^checksum\(node: ref<any>\) -> f64$/m);
  assert.match(prompt, /call it by name instead of/);
  assert.match(prompt, /writing out what it does\. Its contract is:/);
  // Both are calls: each recurses, and a body that reaches itself is not one a
  // candidate can write out, so each is named as a call rather than a body.
  assert.doesNotMatch(prompt, /^WRITE OUT$/m);
  // The entry is excluded: a candidate is already the implementation of it.
  assert.doesNotMatch(prompt, /^blaze_main\(/m);
});

test("a candidate that reaches nothing else is told the program is what it is checked by", () => {
  // The counterpart of the rule above: `createTree` reaches only itself, and a
  // body that reaches itself is the body being written, so there is no other
  // function to offer as a call and none to write out either.
  const { program, semantics } = programWithSemantics("typescript", TREES, "1.ts");
  const prompt = buildUserPrompt(
    request({
      contract: treeProgram.files[0].functions.createTree,
      unit: { file: "1.ts", function: "createTree" },
      program,
      semantics,
      sources: [{ path: "1.ts", source: TREES["1.ts"] }],
    }),
  );
  assert.doesNotMatch(prompt, /^CALLS$/m);
  assert.doesNotMatch(prompt, /^WRITE OUT$/m);
  // Nothing checks it on its own, and it is told so rather than left to
  // assume a caller checks the result: the program it belongs to is the oracle.
  assert.match(prompt, /Nothing checks this function on its own/);
  assert.match(prompt, /compares what it prints with what the source program prints/);
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
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program: treeProgram, semantics: treeSemantics, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  // Nothing runs such a function on its own, so the program is the oracle, and
  // its output is the specification the model has to hit character for character.
  assert.match(prompt, /compares what it prints with what the source/);
  assert.match(prompt, /blaze_rt_print_number and never format one yourself/);
  assert.match(prompt, /70, not\n? ?70\.0/);
  // It states no postcondition, so it is told that is the case rather than
  // being given a result definition to meet.
  assert.match(prompt, /There is no postcondition/);
  assert.match(prompt, /MEMORY REQUIREMENTS/);
  assert.match(prompt, /A number in the source is a double/);
});

test("a contract that states a result keeps the memory and numeric sections", () => {
  const { program, semantics } = programWithSemantics("typescript", LIBRARY, "hello_world.ts", {
    entry: "dotProduct",
  });
  const contract = program.files[0].functions.dotProduct;
  const prompt = buildUserPrompt(
    request({ contract, unit: { file: "hello_world.ts", function: "dotProduct" }, program, semantics, sources: [{ path: "hello_world.ts", source: LIBRARY["hello_world.ts"] }] }),
  );

  assert.match(prompt, /result == sum\(i = 0\.\.<n/);
  assert.match(prompt, /reads: a\[0:n\], b\[0:n\]/);
  assert.match(prompt, /NUMERICAL SEMANTICS/);
  // A buffer arrives as a bare pointer; the length is one of the parameters,
  // which is what the precondition len(a) >= n is about.
  assert.match(prompt, /a bare pointer to the first element/);
});

test("the target says which instructions the machine has", () => {
  const { program, semantics } = programWithSemantics("typescript", TREES, "1.ts");
  const prompt = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, semantics, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );

  assert.match(prompt, /instruction set: the x86_64 baseline, and nothing wider/);
  assert.match(prompt, /architecture: x86_64/);

  const wide = buildUserPrompt(
    request({
      contract: treeChecksum,
      unit: { file: "1.ts", function: "checksum" },
      program,
      semantics,
      sources: [{ path: "1.ts", source: TREES["1.ts"] }],
      target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: ["avx2"] },
    }),
  );
  assert.match(wide, /instruction set: avx2/);
});

test("the effects of the source and the prohibition on the implementation are not the same rule", () => {
  const { program, semantics } = programWithSemantics("typescript", TREES, "1.ts");
  const printing = buildUserPrompt(
    request({ contract: treeMain, unit: { file: "1.ts", function: "main" }, program, semantics, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );
  assert.match(printing, /the source function: io, syscall/);
  // The effect is the source's to state and the runtime call is the compiler's
  // to write, so a candidate is told which effects it may state and nothing
  // about how they are reached.
  assert.match(printing, /The compiler reaches them through the runtime when it lowers your IR, so state the effect in/);
  assert.match(printing, /the compiler writes the call: printing, the command line, the heap/);

  const pure = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, semantics, sources: [{ path: "1.ts", source: TREES["1.ts"] }] }),
  );
  assert.match(pure, /none: the source function touches nothing outside its arguments/);
});

test("a second candidate is told what makes it worth a request", () => {
  const { program, semantics } = programWithSemantics("typescript", TREES, "1.ts");
  const sources = [{ path: "1.ts", source: TREES["1.ts"] }];
  const first = buildUserPrompt(
    request({ contract: treeChecksum, unit: { file: "1.ts", function: "checksum" }, program, semantics, sources }),
  );
  const second = buildUserPrompt(
    request({
      contract: treeChecksum,
      unit: { file: "1.ts", function: "checksum" },
      program,
      semantics,
      sources,
      candidate: 2,
      candidates: 2,
    }),
  );

  assert.doesNotMatch(first, /only worth its request/);
  assert.match(second, /candidate 2 of 2/);
  assert.match(second, /only worth its request if it takes a/);
});

/**
 * A function that prints and allocates nothing: the shape the compiler
 * contracts for a `void` function whose body is a console.log. It is the
 * smallest program there is, and the one the body a candidate is handed has
 * to be right about.
 */
const SAYING = {
  "main.ts": 'import { say } from "./say.ts";\nsay();\n',
  "say.ts": "export function say(): void {\n  console.log(`hello`);\n}\n",
};

test("a function that prints is told the printers, and one that prints nothing is told none", () => {
  const { program, semantics } = programWithSemantics("typescript", SAYING, "main.ts");
  const sources = Object.entries(SAYING).map(([path, source]) => ({ path, source }));
  const prompt = buildUserPrompt(
    request({
      contract: program.files.find((file) => file.path === "say.ts")!.functions.say,
      unit: { file: "say.ts", function: "say" },
      program,
      semantics,
      sources,
    }),
  );

  // A `print_text` in the answer is the compiler lowering one of these, so the
  // runtime printers are named. The text it prints is a value the IR builds
  // out of parts, so no string constructor is named and none is needed: a
  // candidate cannot call one the answer has no way to write.
  assert.match(prompt, /Print with blaze_rt_print_text for text, blaze_rt_print_number for a number, and blaze_rt_print_newline to end a line/);
  assert.match(prompt, /^ {2}print_text "hello"$/m);
  assert.doesNotMatch(prompt, /blaze_rt_string_new/);

  // A function that prints nothing is offered no printer: `checksum` reads a
  // tree and returns a number, so it has no text to build and none is named.
  const silent = buildUserPrompt(
    request({
      contract: treeChecksum,
      unit: { file: "1.ts", function: "checksum" },
      program: treeProgram,
      semantics: treeSemantics,
      sources: [{ path: "1.ts", source: TREES["1.ts"] }],
    }),
  );
  assert.doesNotMatch(silent, /blaze_rt_print_text/);
  assert.doesNotMatch(silent, /Print with blaze_rt_print_number/);
});

test("the system prompt says the same thing to every build", () => {
  // Every kind answers in the IR and the compiler writes the target code, so
  // there is no build a model is told about differently from any other.
  const system = buildSystemPrompt();
  assert.match(system, /The IR you write is the program/);
  assert.match(system, /The target code, the build, the harness and the host are compiler/);
  assert.doesNotMatch(system, /WebAssembly|assembly|GAS/);
});

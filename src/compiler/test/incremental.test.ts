import assert from "node:assert/strict";
import { test } from "node:test";
import { readIncremental, reusable, unitKey, type IncrementalEntry, type UnitKeyInput } from "../incremental.ts";
import { reusableFiles, type CodegenWorkspace } from "../codegen.ts";
import type { Candidate, CandidateOutcome, FunctionContract, ObjectLayout, ProgramContract } from "../core/types.ts";
import { createJsonStore } from "../core/json-store.ts";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { fingerprintSources, toolchainFingerprint } from "../core/version.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { returns as returnsValue } from "./definition.ts";

function contractOf(name: string, returns: string, objects: Record<string, ObjectLayout> = {}): FunctionContract {
  return {
    version: "1",
    function: {
      name,
      symbol: name,
      params: [{ name: "x", type: "f64" }],
      returns,
    },
    requires: [],
    ensures: [`result == x`],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "latency" },
    definition: returnsValue({ k: "ident", name: "x" }, objects),
  };
}

function programOf(...functions: FunctionContract[]): ProgramContract {
  return {
    version: "1",
    language: "typescript",
    entry: { file: "main.ts", function: null },
    files: [{ path: "main.ts", functions: Object.fromEntries(functions.map((entry) => [entry.function.name, entry])), imports: [] }],
    edges: [],
  };
}

const INPUT: UnitKeyInput = {
  contract: contractOf("main", "f64"),
  file: "main.ts",
  program: programOf(contractOf("main", "f64"), contractOf("helper", "f64")),
  target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
  output: "machine",
  mode: "debug",
  backend: "c",
  runtime: "none",
  test: { randomCases: 24, maxLength: 1024, seed: 7 },
  benchmark: { iterations: 2000 },
  model: "openai/gpt-5",
  compilerVersion: "0.1.0",
  toolchain: "fingerprint-of-the-sources",
};

function keyOf(overrides: Partial<UnitKeyInput>): string {
  return unitKey({ ...INPUT, ...overrides });
}

test("a key is the same for the same inputs and different for anything else", () => {
  assert.equal(keyOf({}), keyOf({}));
  for (const change of [
    { contract: contractOf("main", "f32") },
    { file: "other.ts" },
    { target: { ...INPUT.target, arch: "aarch64" as const } },
    { output: "asm" as const },
    // The backend is what wrote the artifact, so an object stored by one is not
    // the object of another even when the output kind is the same.
    { backend: "wasm" as const },
    // The flags an object was built with are in no contract and no target, so a
    // mode change has to reach the key or a build reuses an object that was
    // built to be read rather than one built to run.
    { mode: "release" as const },
    { runtime: "nim" as const },
    { test: { ...INPUT.test, randomCases: 25 } },
    { benchmark: { iterations: 10 } },
    { model: "anthropic/claude-sonnet-4-5" },
    { compilerVersion: "0.2.0" },
    // The compiler's own sources decide the prompt, the runtime and the
    // assembler rules, none of which a contract or a target names, so an edit
    // to any of them has to reach every key.
    { toolchain: "a-fingerprint-of-different-sources" },
  ]) {
    assert.notEqual(keyOf(change), keyOf({}), JSON.stringify(change));
  }
});

test("a callee whose body changed does not invalidate the caller", () => {
  // The caller is linked against the callee's ABI, and a body is not part of
  // it: the callee is regenerated, and the object that calls it still is right.
  const before = programOf(contractOf("main", "f64"), contractOf("helper", "f64"));
  const after = programOf(contractOf("main", "f64"), { ...contractOf("helper", "f64"), ensures: ["result == (x + 1)"] });
  assert.equal(keyOf({ program: after }), keyOf({ program: before }));
});

test("a callee whose signature or object layout changed invalidates the caller", () => {
  // These are the two changes that can break an object that is not rebuilt.
  const signature = programOf(contractOf("main", "f64"), contractOf("helper", "i32"));
  assert.notEqual(keyOf({ program: signature }), keyOf({}));

  const layout = programOf(
    contractOf("main", "f64"),
    contractOf("helper", "f64", { node: { name: "node", size: 8, align: 8, fields: [] } }),
  );
  assert.notEqual(keyOf({ program: layout }), keyOf({}));
});

function entry(overrides: Partial<IncrementalEntry> = {}): IncrementalEntry {
  const candidate: Candidate = {
    id: "c1",
    text: ".globl main\nmain:\n  ret\n",
    model: "openai/gpt-5",
    modelConfig: "openai/gpt-5",
    generatedAt: "2026-01-01T00:00:00.000Z",
    candidate: 1,
    round: 1,
  };
  const outcome: CandidateOutcome = { candidate: "c1", valid: true, verification: { candidate: "c1", passed: true, cases: 4, tolerance: null, failures: [], durationNs: 1 } };
  return {
    key: "k",
    file: "main.ts",
    selected: "c1",
    candidates: [candidate],
    outcomes: [outcome],
    benchmarkVector: null,
    ...overrides,
  };
}

test("only what a build proved, and only from the same inputs, may be reused", () => {
  assert.equal(reusable(entry(), "k", true), "object");
  // Files that are gone leave the implementation, which the toolchain rebuilds.
  assert.equal(reusable(entry(), "k", false), "assembly");
  // A key from different inputs is not this object.
  assert.equal(reusable(entry(), "other", true), null);
  assert.equal(reusable(undefined, "k", true), null);
  // A candidate the toolchain rejected is not a proof of anything.
  const rejected = entry({ outcomes: [{ candidate: "c1", valid: false, failure: { category: "AssemblyError", stage: "assemble", message: "no" } }] });
  assert.equal(reusable(rejected, "k", true), null);
  assert.equal(reusable(entry({ selected: "c2" }), "k", true), null);
});

test("a record that is not JSON is no record, not a build that cannot start", async () => {
  const root = await mkdtemp(join(tmpdir(), "blaze-incremental-"));
  const store = createJsonStore(join(root, ".blaze"));
  await store.writeText("projects/p/incremental.json", "{ not json");

  // A cache the compiler cannot read is one it rebuilds. Failing here instead
  // leaves a project with no way back short of deleting the file by hand.
  assert.deepEqual(await readIncremental(store, "projects/p/incremental.json"), {});
  assert.deepEqual(await readIncremental(store, "projects/absent.json"), {});
});

test("two stores writing the same path do not share a temporary name", async () => {
  const root = await mkdtemp(join(tmpdir(), "blaze-store-"));
  const first = createJsonStore(join(root, ".blaze"));
  const second = createJsonStore(join(root, ".blaze"));

  // Both name their temporary by the file, the process and a counter. A
  // counter per store restarts at zero for each of them, so two writes that
  // overlap here would write the same temporary and one would rename the
  // other's away.
  await Promise.all([first.write("projects/p/build.json", { from: "first" }), second.write("projects/p/build.json", { from: "second" })]);

  const written = await first.read<{ from: string }>("projects/p/build.json");
  assert.ok(["first", "second"].includes(written.from), `unexpected record: ${JSON.stringify(written)}`);
  const left = (await readdir(join(root, ".blaze/projects/p"))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(left, [], "a temporary file was left behind");
});

test("a function the source named __proto__ is a stored implementation like any other", async () => {
  // The record is keyed by whatever the source called the function, and
  // `__proto__` is a legal name to call one. On an object with the usual
  // prototype, assigning to that key is the inherited setter rather than an
  // assignment: it replaces the prototype, adds no entry, and the stored
  // implementation is dropped on the way in and never read on the way out.
  const directory = await mkdtemp(join(tmpdir(), "blaze-proto-"));
  const entry = (key: string) =>
    `{"key":"${key}","file":"f","selected":"c1","candidates":[],"outcomes":[{"candidate":"c1","valid":true}]}`;
  // Written as text: `__proto__` in an object literal is the prototype setter,
  // so a record built in memory would never have carried the key at all.
  await writeFile(join(directory, "inc.json"), `{"good":${entry("k1")},"__proto__":${entry("k2")}}`);
  const record = await readIncremental(createJsonStore(directory), "inc.json");
  assert.deepEqual(Object.keys(record).sort(), ["__proto__", "good"]);
  assert.equal(record.good?.key, "k1");
  assert.equal(Object.prototype.hasOwnProperty.call(record, "__proto__"), true);
});

test("an edit to any compiler source moves the fingerprint every key is built from", async () => {
  const root = await mkdtemp(join(tmpdir(), "blaze-fingerprint-"));
  await mkdir(join(root, "toolchain"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "codegen.ts"), "export const one = 1;\n", "utf8");
  await writeFile(join(root, "toolchain/assembler.ts"), "export const as = 'as';\n", "utf8");
  // Neither of these is compiled into a build, so neither may reach the key.
  await writeFile(join(root, "test/cases.test.ts"), "export const noise = 1;\n", "utf8");
  await writeFile(join(root, "README.md"), "one = 1\n", "utf8");

  const before = await fingerprintSources(root);
  assert.equal(before, await fingerprintSources(root), "the same tree fingerprinted twice");
  assert.match(before, /^[0-9a-f]{64}$/);

  // The parts of the compiler that decide what an implementation is, without
  // one of which a key would keep matching across the edit.
  for (const file of ["codegen.ts", join("toolchain", "assembler.ts")]) {
    const original = await readFile(join(root, file), "utf8");
    await writeFile(join(root, file), `${original}export const extra = 2;\n`, "utf8");
    const edited = await fingerprintSources(root);
    assert.notEqual(edited, before, `an edit to ${file} left the fingerprint alone`);
    await writeFile(join(root, file), original, "utf8");
  }
  assert.equal(await fingerprintSources(root), before, "an edit that was undone still moved the fingerprint");

  // What is not compiled into a build cannot change what is compiled into it.
  await writeFile(join(root, "test/cases.test.ts"), "export const noise = 2;\n", "utf8");
  await writeFile(join(root, "README.md"), "one = 2\n", "utf8");
  assert.equal(await fingerprintSources(root), before, "a test or a readme reached the fingerprint");

  // The path is part of what is hashed, so moving a file is an edit.
  await rename(join(root, "toolchain/assembler.ts"), join(root, "toolchain/linker.ts"));
  assert.notEqual(await fingerprintSources(root), before, "a renamed file left the fingerprint alone");

  // The compiler this process is running from fingerprints to something.
  assert.match(await toolchainFingerprint(), /^[0-9a-f]{64}$/);
});

test("every file a build consumes from a reused candidate is one it asked for", () => {
  // The list decides whether a stored candidate is reused as an object or only
  // as the text it was built from, so a file the build goes on to consume and
  // the list does not name is a reuse that passes and then fails. A build
  // reusing an `ir` candidate that links on its own still delivers that
  // executable, and every kind that assembles still links the object when the
  // deliverable is a program.
  const workspace: CodegenWorkspace = { workDirectory: "/w", functionName: "dotProduct" };
  const names = (
    output: Parameters<typeof reusableFiles>[2],
    linksObjects: boolean,
    standalone: boolean,
    lowering: Parameters<typeof reusableFiles>[3] = "c",
  ): string[] =>
    reusableFiles(workspace, "c1", output, lowering, linksObjects, standalone).map((file) => file.slice("/w/c1".length));

  // A `machine` candidate is always linked on its own, so its executable is
  // always a file the build consumes.
  assert.deepEqual(names("machine", false, true), [".s", ""]);
  // A standalone `ir` candidate delivers the executable it links.
  assert.deepEqual(names("ir", false, true), [".ir", ""]);
  // One that calls into the program is never linked on its own, so it has no
  // executable and demanding one would make it a cache miss for ever.
  assert.deepEqual(names("ir", false, false), [".ir"]);
  // Every kind that assembles produces an object, and a program build links it.
  assert.deepEqual(names("asm", true, true), [".s", ".o"]);
  assert.deepEqual(names("c", true, true), [".c", ".o"]);
  assert.deepEqual(names("c", false, true), [".c"]);
  // A module is the whole deliverable of a wasm build, and it links nothing.
  assert.deepEqual(names("wasm", false, true, "wasm"), [".s", ".wasm"]);
  // A program build links the object of every function it holds, whatever the
  // output kind and whether or not the candidate also links on its own. The
  // executable question and the object question are separate: a standalone
  // `ir` or `machine` candidate delivers an executable AND is linked as an
  // object, and asking the first question must not swallow the second.
  assert.deepEqual(names("ir", true, true), [".ir", "", ".o"]);
  assert.deepEqual(names("ir", true, false), [".ir", ".o"]);
  assert.deepEqual(names("machine", true, true), [".s", "", ".o"]);
  assert.deepEqual(names("machine", true, false), [".s", "", ".o"]);
  assert.deepEqual(names("asm", true, false), [".s", ".o"]);
  // A wasm build links no object at all, whatever the program around it does.
  assert.deepEqual(names("wasm", true, true, "wasm"), [".s", ".wasm"]);
});

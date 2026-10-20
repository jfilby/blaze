import assert from "node:assert/strict";
import { test } from "node:test";
import { readIncremental, reusable, unitKeys, type IncrementalEntry, type UnitKeyInput, type UnitKeys } from "../incremental.ts";
import { reusableFiles, type CodegenWorkspace } from "../codegen.ts";
import type { Candidate, CandidateOutcome, FunctionContract, GenerationConfig, ObjectLayout, ProgramContract } from "../core/types.ts";
import { createJsonStore } from "../core/json-store.ts";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { COMPILER_VERSION, engineStamp, fingerprintSources, toolchainFingerprints } from "../core/version.ts";
import { join } from "node:path";
import { returns as returnsValue } from "./definition.ts";
import { scratch } from "./scratch.ts";
import { inspectProject, STATE_DIRECTORY } from "../compiler.ts";
import type { BuildStatus } from "../core/types.ts";
import { programWithSemantics } from "./phase.ts";

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

/** How hard the build was asked to look, which the reuse key is over. */
const GENERATION: GenerationConfig = {
  maxCandidates: 2,
  maxAttempts: 3,
  maxRetries: 2,
  candidateConcurrency: 2,
  functionConcurrency: 2,
  timeoutSeconds: 120,
};

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
  generation: GENERATION,
  model: "openai/gpt-5",
  compilerVersion: "0.1.0",
  review: "fingerprint-of-the-sources",
  lowering: "fingerprint-of-the-sources",
};

function keyOf(overrides: Partial<UnitKeyInput>): UnitKeys {
  return unitKeys({ ...INPUT, ...overrides });
}

test("a key is the same for the same inputs and different for anything else", () => {
  assert.equal(keyOf({}).review, keyOf({}).review);
  for (const change of [
    { contract: contractOf("main", "f32") },
    { file: "other.ts" },
    { target: { ...INPUT.target, arch: "aarch64" as const } },
    { output: "asm" as const },
    // The backend is what wrote the artifact, so an object stored by one is not
    // the object of another even when the output kind is the same: a `c` object
    // is what gcc made of the C the compiler wrote, and a `machine` one is what
    // the compiler encoded.
    { backend: "wasm" as const },
    { backend: "machine" as const },
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
    { review: "a-fingerprint-of-different-sources" },
  ]) {
    assert.notDeepEqual(keyOf(change).review, keyOf({}).review, JSON.stringify(change));
  }
});

test("an edit to the lowering leaves the review standing and the object behind", () => {
  // The point of the split: what a model said was about the IR, and a change to
  // the assembler, the encoder or the runtime cannot change the IR. So the
  // review key is the one that holds, and the candidates a previous build
  // produced are still what it reviewed — while the object they were lowered
  // into is not what this build would produce, and must not be linked.
  const before = keyOf({});
  const after = keyOf({ lowering: "a-fingerprint-of-different-lowering" });
  assert.equal(after.review, before.review, "an edit to the lowering moved the review key");
  assert.notEqual(after.object, before.object, "an edit to the lowering left the object key alone");

  // The other direction has to hold too, or the object key would be a second
  // review key that happened to be checked too: an edit to the review has to
  // invalidate the object, because the object was built from what was reviewed.
  const reviewed = keyOf({ review: "a-fingerprint-of-different-sources" });
  assert.notEqual(reviewed.review, before.review);
  assert.notEqual(reviewed.object, before.object, "an edit to the review left the object key alone");
});

test("a callee whose body changed invalidates the caller", () => {
  // The key covers more than what this object is linked against. Whether a loop
  // of this function may run its turns on more than one thread, and whether a
  // turn may rewind the storage it allocated, is read out of the bodies this
  // function calls, so an edit to one of them changes what is emitted here: the
  // stored object of a caller keyed on a callee's ABI alone was a threaded loop
  // over a callee that had been edited into one that writes.
  //
  // Both callees are here because the two rules that read a body are not the same
  // rule: a callee the fold can inline is written into this object, and one it
  // cannot is still read by the analyses that mark this caller's own loops.
  const keyFor = (callee: readonly string[], calleeBody: string): string => {
    const { program } = programWithSemantics(
      "typescript",
      {
        "main.ts": [
          ...callee,
          `  return ${calleeBody};`,
          `}`,
          `export function use(n: number): number {`,
          `  return helper(n);`,
          `}`,
          `use(2);`,
          ``,
        ].join("\n"),
      },
      "main.ts",
    );
    return unitKeys({ ...INPUT, contract: program.files[0].functions.use, program }).review;
  };
  const plain = ["function helper(n: number): number {"];
  const printing = ["function helper(n: number): number {", "  console.log(`x`);"];
  assert.notEqual(keyFor(plain, "n * 2"), keyFor(plain, "n * 3"), "an edit to a called body left the caller's key alone");
  assert.notEqual(
    keyFor(printing, "n * 2"),
    keyFor(printing, "n * 3"),
    "an edit to a callee that cannot be inlined left the caller's key alone",
  );
});

test("a callee whose signature or object layout changed invalidates the caller", () => {
  // These are the two changes that can break an object that is not rebuilt.
  const signature = programOf(contractOf("main", "f64"), contractOf("helper", "i32"));
  assert.notEqual(keyOf({ program: signature }).review, keyOf({}).review);

  const layout = programOf(
    contractOf("main", "f64"),
    contractOf("helper", "f64", { node: { name: "node", size: 8, align: 8, fields: [] } }),
  );
  assert.notEqual(keyOf({ program: layout }).review, keyOf({}).review);
});

test("a callee whose declared effects changed invalidates the caller", () => {
  // The effects a function's contract declares are read out of the *callee's*
  // contract when the caller's own IR is built: `parallel.ts` refuses to thread a
  // loop whose turn calls something with an effect other than `memory`, and
  // `repair.ts` refuses to inline one. The definition records what the body
  // does, not what it says it may do, and the printed IR re-derives the effects

  // from the contract rather than carrying them — so a callee whose contract
  // gained an effect while its body stood still changed what the caller emits,
  // and nothing the key hashed moved. The stored object was the one with the
  // loop threaded, and it is the one that gets linked.
  const effectful = { ...contractOf("helper", "f64"), effects: ["io" as const] };
  assert.notEqual(
    keyOf({ program: programOf(contractOf("main", "f64"), effectful) }).review,
    keyOf({}).review,
    "a callee that gained an effect left the caller's key alone",
  );
});

test("a build asked to look harder invalidates what an easier one stored", () => {
  // How many candidates a build may write, how many rounds each gets and how
  // many times a failed round is taken again decide which answer the build
  // settles on, and none of them is named by a contract or a target. Raising
  // `max_candidates` from two to six left every key where it was, so the build
  // reused the two-candidate selection and delivered the one the earlier
  // configuration had chosen — an answer a build with the new configuration
  // would never have looked at.
  assert.notEqual(
    keyOf({ generation: { ...GENERATION, maxCandidates: 6 } }).review,
    keyOf({}).review,
    "raising the number of candidates left the key alone",
  );
  assert.notEqual(
    keyOf({ generation: { ...GENERATION, maxAttempts: 5 } }).review,
    keyOf({}).review,
    "raising the attempts per candidate left the key alone",
  );
  assert.notEqual(
    keyOf({ generation: { ...GENERATION, timeoutSeconds: 600 } }).review,
    keyOf({}).review,
    "raising the time a round may take left the key alone",
  );
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
    reviewKey: "r",
    objectKey: "o",
    file: "main.ts",
    selected: "c1",
    candidates: [candidate],
    outcomes: [outcome],
    benchmarkVector: null,
    ...overrides,
  };
}

test("only what a build proved, and only from the same inputs, may be reused", () => {
  const keys: UnitKeys = { review: "r", object: "o" };
  assert.equal(reusable(entry(), keys, true), "object");
  // Files that are gone leave the implementation, which the toolchain rebuilds.
  assert.equal(reusable(entry(), keys, false), "assembly");
  // A key from different inputs is not this object.
  assert.equal(reusable(entry(), { review: "other", object: "o" }, true), null);
  assert.equal(reusable(undefined, keys, true), null);
  // A candidate the toolchain rejected is not a proof of anything.
  const rejected = entry({ outcomes: [{ candidate: "c1", valid: false, failure: { category: "AssemblyError", stage: "assemble", message: "no" } }] });
  assert.equal(reusable(rejected, keys, true), null);
  assert.equal(reusable(entry({ selected: "c2" }), keys, true), null);
});

test("an object from another lowering is rebuilt and an object from this one is linked", () => {
  // The whole point of the second key. An edit to the assembler or the runtime
  // leaves what a model reviewed standing, so the candidates are reused — but
  // the object was written by rules this build no longer has, so it is put
  // through the toolchain again rather than linked as freshly proved.
  const built = keyOf({});
  const stored = entry({ reviewKey: built.review, objectKey: built.object });
  const relowered = keyOf({ lowering: "a-different-lowering" });
  assert.equal(reusable(stored, relowered, true), "assembly", "an object from another lowering was linked as-is");
  // And the other way: once this build has lowered it, its own object key is the
  // one that matches, so a rebuild with no further edit links it.
  assert.equal(reusable(entry({ reviewKey: built.review, objectKey: relowered.object }), relowered, true), "object");
  // A review that does not match is no reuse at either level, however complete
  // the object beside it is.
  assert.equal(reusable(stored, { review: "a-different-review", object: built.object }, true), null);
});

test("a record that is not JSON is no record, not a build that cannot start", async () => {
  const root = await scratch("blaze-incremental-");
  const store = createJsonStore(join(root, ".blaze"));
  await store.writeText("projects/p/incremental.json", "{ not json");

  // A cache the compiler cannot read is one it rebuilds. Failing here instead
  // leaves a project with no way back short of deleting the file by hand.
  // Stated as the keys it holds rather than against a `{}` literal, because
  // the record is built with no prototype and is not one.
  assert.deepEqual(Object.keys(await readIncremental(store, "projects/p/incremental.json")), []);
  assert.deepEqual(Object.keys(await readIncremental(store, "projects/absent.json")), []);
});

test("two stores writing the same path do not share a temporary name", async () => {
  const root = await scratch("blaze-store-");
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
  const directory = await scratch("blaze-proto-");
  const entry = (key: string) =>
    `{"reviewKey":"${key}","objectKey":"${key}","file":"f","selected":"c1","candidates":[],"outcomes":[{"candidate":"c1","valid":true}]}`;
  // Written as text: `__proto__` in an object literal is the prototype setter,
  // so a record built in memory would never have carried the key at all.
  await writeFile(join(directory, "inc.json"), `{"good":${entry("k1")},"__proto__":${entry("k2")}}`);
  const record = await readIncremental(createJsonStore(directory), "inc.json");
  assert.deepEqual(Object.keys(record).sort(), ["__proto__", "good"]);
  assert.equal(record.good?.reviewKey, "k1");
  assert.equal(Object.prototype.hasOwnProperty.call(record, "__proto__"), true);
});

test("the empty record a first build writes into keeps a function named __proto__", async () => {
  // A project's first build has no record on disk, so what it writes into is
  // the empty one this returns. That object is the one the assignment at the
  // end of a verified function lands on, and on an object carrying the usual
  // prototype the assignment is the inherited setter: it replaces the
  // prototype, adds no entry, and the spread that writes the record back
  // carries the entry nowhere. The function is then never cached, and every
  // other function name reads the entry's own fields off the prototype.
  const directory = await scratch("blaze-proto-empty-");
  const record = await readIncremental(createJsonStore(directory), "inc.json");
  record.__proto__ = entry({ outcomes: [{ candidate: "c1", valid: true }] });

  assert.equal(Object.prototype.hasOwnProperty.call(record, "__proto__"), true, "the entry was not recorded");
  assert.deepEqual(Object.keys({ ...record }), ["__proto__"], "the written record lost the function");
  // A second function must not read the first one's entry out of the
  // prototype: these are the field names of an entry.
  assert.equal(record.selected, undefined, "a field name answered from the prototype");
  assert.equal(record.reviewKey, undefined, "a field name answered from the prototype");
  assert.equal(record.objectKey, undefined, "a field name answered from the prototype");
});

test("an edit to a compiler source moves the fingerprint that decides it", async () => {
  const root = await scratch("blaze-fingerprint-");
  await mkdir(join(root, "toolchain"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  // One source on each side of the line, and one on neither: `codegen.ts` is
  // the orchestrator and `toolchain/assembler.ts` is on `LOWERING_ONLY`, while
  // `toolchain/verifier.ts` is in the same directory and is not.
  await writeFile(join(root, "codegen.ts"), "export const one = 1;\n", "utf8");
  await writeFile(join(root, "toolchain/assembler.ts"), "export const as = 'as';\n", "utf8");
  await writeFile(join(root, "toolchain/verifier.ts"), "export const ve = 've';\n", "utf8");
  // Neither of these is compiled into a build, so neither may reach a key.
  await writeFile(join(root, "test/cases.test.ts"), "export const noise = 1;\n", "utf8");
  await writeFile(join(root, "README.md"), "one = 1\n", "utf8");

  const before = await fingerprintSources(root);
  assert.deepEqual(before, await fingerprintSources(root), "the same tree fingerprinted twice");
  assert.match(before.review, /^[0-9a-f]{64}$/);
  assert.match(before.lowering, /^[0-9a-f]{64}$/);
  assert.notEqual(before.review, before.lowering, "the two fingerprints cover the same sources");

  const edit = async (file: string, body: string): Promise<void> => {
    await writeFile(join(root, file), body, "utf8");
  };

  // The whole point of the split, stated as the two hashes: an edit to a
  // lowering-only source moves the object and leaves the review, which is what
  // lets a build keep the candidates a model already reviewed.
  {
    const file = join("toolchain", "assembler.ts");
    const original = await readFile(join(root, file), "utf8");
    await edit(file, `${original}export const extra = 2;\n`);
    const after = await fingerprintSources(root);
    assert.notEqual(after.lowering, before.lowering, `an edit to ${file} left the lowering alone`);
    assert.equal(after.review, before.review, `an edit to ${file} moved the review it cannot affect`);
    await edit(file, original);
  }

  // A source on the review side moves the review, and has to move the object
  // too: the object was built from what was reviewed.
  for (const file of ["codegen.ts", join("toolchain", "verifier.ts")]) {
    const original = await readFile(join(root, file), "utf8");
    await edit(file, `${original}export const extra = 2;\n`);
    const after = await fingerprintSources(root);
    assert.notEqual(after.review, before.review, `an edit to ${file} left the review alone`);
    assert.equal(after.lowering, before.lowering, `an edit to ${file} moved the lowering it cannot affect`);
    await edit(file, original);
  }

  // A source that is on neither list is on the review side, which is the safe
  // direction: an edit to it discards work the build could have kept rather
  // than keeping work the edit invalidated. This is why a new source starts
  // there and is moved across only with a reason.
  {
    const file = join("toolchain", "not-listed-yet.ts");
    await edit(file, "export const fresh = 1;\n");
    const added = await fingerprintSources(root);
    assert.notEqual(added.review, before.review, "a new source did not reach the review fingerprint");
    assert.equal(added.lowering, before.lowering, "a source that is on no list moved the lowering");
    await edit(file, `${await readFile(join(root, file), "utf8")}export const more = 2;\n`);
    assert.notEqual((await fingerprintSources(root)).review, added.review, "an edit to a new source went unnoticed");
    await rm(join(root, file));

  }

  assert.deepEqual(await fingerprintSources(root), before, "an edit that was undone still moved the fingerprint");

  // What is not compiled into a build cannot change what is compiled into it.
  await edit(join("test", "cases.test.ts"), "export const noise = 2;\n");
  await edit("README.md", "one = 2\n");
  assert.deepEqual(await fingerprintSources(root), before, "a test or a readme reached a fingerprint");

  // The path is part of what is hashed, so moving a file is an edit. Moving one
  // across the line moves both fingerprints, because it lands on the other
  // side of it.
  // The path is part of what is hashed, so moving a file is an edit. Both of
  // these names are on the lowering side, so a move between them stays there:
  // the object it produces is a different one, and what a model reviewed is not.
  await rename(join(root, "toolchain/assembler.ts"), join(root, "toolchain/linker.ts"));
  const moved = await fingerprintSources(root);
  assert.equal(moved.review, before.review, "a rename within the lowering side moved the review");
  assert.notEqual(moved.lowering, before.lowering, "a renamed file left the lowering alone");

  // A tree that cannot be read is not one whose caches may be trusted, and says
  // so for both halves rather than for only the one it is asked about.
  const unreadable = await fingerprintSources(join(root, "no-such-directory"));
  assert.notEqual(unreadable.review, before.review);
  assert.equal(unreadable.review, unreadable.lowering, "an unreadable tree fingerprinted as two different things");

  // The compiler this process is running from fingerprints to something.
  const here = await toolchainFingerprints();
  assert.match(here.review, /^[0-9a-f]{64}$/);
  assert.match(here.lowering, /^[0-9a-f]{64}$/);
});

test("the engine stamp names the release and the sources that decide a function", async () => {
  // The stamp is what a build record carries so the next run can tell whether
  // the compiler moved under it. It has to move when the sources that decide
  // what a function is move, or a build reuses an object a different compiler
  // made and calls it freshly proved.
  const root = await scratch("blaze-engine-");
  await mkdir(join(root, "toolchain"), { recursive: true });
  await writeFile(join(root, "toolchain", "ir-c.ts"), "export const lowering = 1;\n", "utf8");
  const before = await fingerprintSources(root);
  const stamp = engineStamp(before);
  assert.match(stamp, new RegExp(`^${COMPILER_VERSION.replace(/\./g, "\\.")}\\+[0-9a-f]{8}$`));

  // A lowering-only source decides what the IR becomes and not what it is, so
  // the candidates an earlier build reviewed still stand and nothing is worth
  // asking the user about.
  await writeFile(join(root, "toolchain", "ir-c.ts"), "export const lowering = 2;\n", "utf8");
  const loweringOnly = await fingerprintSources(root);
  assert.notEqual(loweringOnly.lowering, before.lowering, "the edit did not reach the lowering");
  assert.equal(engineStamp(loweringOnly), stamp, "a lowering edit moved the engine");

  await writeFile(join(root, "toolchain", "ir-c.ts"), "export const lowering = 1;\n", "utf8");
  await writeFile(join(root, "review.ts"), "export const prompt = 1;\n", "utf8");
  const reviewSide = await fingerprintSources(root);
  assert.notEqual(reviewSide.review, before.review, "the edit did not reach the review");
  assert.notEqual(engineStamp(reviewSide), stamp, "an edit that invalidates every candidate left the engine stamp alone");
  await rm(root, { recursive: true, force: true });
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

  // Every kind delivers the IR beside the target it was lowered from, so it is
  // named by every list: a build that took the object-level short-circuit and
  // then found no IR to deliver failed after having linked and verified
  // everything else.
  // A candidate that links on its own delivers the executable it links, and a
  // `machine` candidate that does not has none: naming it anyway asked the
  // build for a file that is never written, so the stored candidate could never
  // be complete and every build rebuilt it for the life of the project.
  assert.deepEqual(names("machine", false, true), [".ir", ".s", ""]);
  // A standalone `ir` candidate delivers the executable it links.
  assert.deepEqual(names("ir", false, true), [".ir", ".ir", ""]);
  // One that calls into the program is never linked on its own, so it has no
  // executable and demanding one would make it a cache miss for ever.
  assert.deepEqual(names("ir", false, false), [".ir", ".ir"]);
  // Every kind that assembles produces an object, and a program build links it.
  // A candidate that links on its own has the harness executable whatever kind
  // it is: the harness is what its vectors run against, so a reused candidate
  // whose executable is missing cannot be verified.
  assert.deepEqual(names("asm", true, true), [".ir", ".s", "", ".o"]);
  assert.deepEqual(names("c", true, true), [".ir", ".c", "", ".o"]);
  assert.deepEqual(names("c", false, true), [".ir", ".c", ""]);
  // A wasm build writes the module and no assembly at all, so naming the
  // assembly here asked for a file that was never written and the object half
  // of the cache was unreachable for that backend for the life of the project.
  // The host that runs the module is delivered beside it and is a file the
  // build consumes — it is what the vectors run against — so it is named too.
  assert.deepEqual(names("wasm", false, true, "wasm"), [".wasm", ".host.mjs", ".ir"]);
  // A backend that writes the object itself delivers that object, which is also
  // what a program build links, so the two questions name the same file twice
  // and the list is still one list.
  assert.deepEqual(names("machine", true, true, "machine"), [".ir", ".o", "", ".o"]);
  assert.deepEqual(names("machine", false, true, "machine"), [".ir", ".o", ""]);
  // The same output kind through the `c` backend delivers the assembly the tool
  // chain made of the C, which is a file of its own beside the object.
  assert.deepEqual(names("machine", true, true), [".ir", ".s", "", ".o"]);
  // A program build links the object of every function it holds, whatever the
  // output kind and whether or not the candidate also links on its own. The
  // executable question and the object question are separate: a standalone
  // `ir` or `machine` candidate delivers an executable AND is linked as an
  // object, and asking the first question must not swallow the second.
  assert.deepEqual(names("ir", true, true), [".ir", ".ir", "", ".o"]);
  assert.deepEqual(names("ir", true, false), [".ir", ".ir", ".o"]);
  assert.deepEqual(names("machine", true, true), [".ir", ".s", "", ".o"]);
  assert.deepEqual(names("machine", true, false), [".ir", ".s", ".o"]);
  assert.deepEqual(names("asm", true, false), [".ir", ".s", ".o"]);
  // A wasm build links no object at all, whatever the program around it does.
  assert.deepEqual(names("wasm", true, true, "wasm"), [".wasm", ".host.mjs", ".ir"]);
});

test("two projects whose names share a prefix each read their own record", async () => {
  // A store directory is `<name>-<12 hex of the path>`, so the directory for
  // `app-2` also begins `app-`. A lookup on the prefix alone answered `app` with
  // `app-2`'s record — and with its contract and candidates — under the name
  // that was asked for.
  const directory = await scratch("blaze-collide-");
  const store = createJsonStore(join(directory, STATE_DIRECTORY));
  const at = (id: string, updatedAt: string): BuildStatus =>
    ({
      id,
      input: `${id}.toml`,
      contract: `projects/${id}/contract.json`,
      target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
      status: "success",
      outputKind: "ir",
      backend: "c",
      mode: "debug",
      runtime: "nim",
      createdAt: updatedAt,
      updatedAt,
      sourceHash: "",
      contractHash: "",
      model: "replay",
      modelConfig: "",
      compilerVersion: "",
      engine: "",
    }) as BuildStatus;
  // `app-2` is written last, so a lookup that takes the first directory
  // alphabetically — which is what it used to do — reads `app-2` for `app`.
  await store.write("projects/app-0123456789ab/build.json", at("app", "2026-01-01T00:00:00.000Z"));
  await store.write("projects/app-2-0123456789ab/build.json", at("app-2", "2026-02-01T00:00:00.000Z"));
  assert.equal((await inspectProject("app", directory)).id, "app");
  assert.equal((await inspectProject("app-2", directory)).id, "app-2");
});


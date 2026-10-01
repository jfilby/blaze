/**
 * The C driver a program build delivers: what it writes down, and what it
 * prints beside the source it was written as.
 *
 * A program is checked against the output of the language it was written in,
 * so the tests here run the source with node and the delivered binary with the
 * compiler, and compare what the two print. The runtime is built once, as a
 * build builds it once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProgramDriver, buildProgramDriver } from "../toolchain/driver.ts";
import { resolveProgram, type SemanticProgram } from "../semantics/ir-resolve.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { run } from "../core/process.ts";
import { diagnostic, phaseOf } from "./phase.ts";
import { semanticIrProblems } from "../semantics/ir-validate.ts";
import { parseSemanticProgram } from "../semantics/ir-text.ts";

/** The object the driver of every program here links against, built once. */
let runtime: Promise<string> | null = null;

/**
 * The command line Deno hands a program, for a source written for Deno and run
 * under node to be compared with what the delivered binary prints.
 */
const DENO_PRELUDE = "data:text/javascript,globalThis.Deno={args:process.argv.slice(2)}";

/** A one file TypeScript program, resolved exactly as a build resolves it. */
function resolved(source: string): SemanticProgram {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.ok(phase.body !== undefined);
  return resolveProgram(phase.body, phase.program);
}

/** The C a program of this source is driven by. */
function driver(source: string): string {
  return generateProgramDriver(resolved(source));
}

/** The program written to disk and the binary it was linked into. */
async function linked(source: string): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), "blaze-program-"));
  await writeFile(join(directory, "main.ts"), source, "utf8");
  // The driver includes the runtime header by name, as a build keeps the
  // runtime beside the driver it links.
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await mkdtemp(join(tmpdir(), "blaze-runtime-"))).then((built) => built.objectPath);
  const runner = await buildProgramDriver({
    mode: "debug",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    program: resolved(source),
    workDirectory: directory,
    objectPaths: [],
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  return { directory, binary: runner.command };
}

/** The binary the program was linked into, and what the source printed. */
async function deliver(source: string): Promise<{ binary: string; original: string }> {
  const { directory, binary } = await linked(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  return { binary, original: original.stdout };
}

test("a compound assignment a whole operator needs is refused on a double", () => {
  const refused = diagnostic(() => resolved("let x = 7;\nx %= 3;\nconsole.log(x);\n"));
  assert.match(refused, /"%" needs whole numbers/);
  // The diagnostic names the type the name is declared at, so it says what to
  // change rather than that something is wrong.
  assert.match(refused, /"x" is a f64/);
});

test("a compound assignment a whole operator needs is written on a whole name", () => {
  // A length is a whole number, so `%=` is C the driver can write down. On a
  // double it would be `x %= 3.0;`, which no C compiler takes.
  const written = driver("const a = new Float64Array([1, 2, 3]);\nlet x = a.length;\nx %= 3;\nconsole.log(x);\n");
  assert.match(written, /\bsize_t x = a_length;/);
  // The literal carries the width of the name it is written on, so the `3` is
  // a `3ULL` here; what this is about is that it is not `3.0`, which is the C
  // no compiler takes for a whole-only operator.
  assert.match(written, /\bx %= 3(?:ULL|LL)?;/);
});

test("a loop bounded by a length is counted with a whole number", () => {
  // The index only ever takes whole values, so a whole-only operator on it is
  // not a diagnostic the source does not raise.
  const written = driver("const a = new Float64Array([1, 2, 3]);\nfor (let i = 0; i < a.length; i++) console.log(i % 2);\n");
  assert.match(written, /for \((?:size_t|int64_t|int32_t) i = /);
  assert.doesNotMatch(written, /for \(double i =/);
});

test("a loop bounded by a length counts as one bounded by a written number", () => {
  const typeOf = (written: string): string => /for \((\w+) i =/.exec(written)?.[1] ?? "";
  const byLength = typeOf(driver("const a = new Float64Array([1, 2, 3]);\nfor (let i = 0; i < a.length; i++) console.log(i % 2);\n"));
  const byLiteral = typeOf(driver("for (let i = 0; i < 3; i++) console.log(i % 2);\n"));
  assert.notEqual(byLength, "");
  assert.notEqual(byLiteral, "");
  assert.equal(/^f(32|64)$/.test(byLength), false, byLength);
  assert.equal(/^f(32|64)$/.test(byLiteral), false, byLiteral);
});

test("a loop that starts between whole numbers counts in fractions", async () => {
  // The index is what it is built from: a start of 0.5 is a fraction however
  // whole the bound is, and counting it with a whole number truncates the
  // start in the C declaration, so the program runs from 0.
  const source = "for (let i = 0.5; i < 3.5; i++) { console.log(i); }\n";
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "0.5\n1.5\n2.5\n");
  assert.equal(delivered.stdout, original);
});

test("a whole index counts in whole numbers against a bound that is not one", async () => {
  // The bound only says where the loop stops, so it does not decide the width
  // the index is counted with. A whole index against a fractional bound stops
  // where the comparison says it does, which is where the source stops it.
  const source = "for (let i = 0; i < 3.5; i++) { console.log(i); }\n";
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "0\n1\n2\n3\n");
  assert.equal(delivered.stdout, original);
});

test("a loop that counts from a value its own index shadows counts from the outer one", () => {
  // The index is declared before the bounds are read, so a bound written in
  // the source under the name the index takes resolved to the loop's own
  // declaration: `for (double n_2 = n_2; ...)` initialises the index from an
  // indeterminate double and the loop counts from whatever was on the stack.
  // The IR backend reads its bounds before it declares the index for the same
  // reason. The C is read rather than run because the same source is a
  // temporal-dead-zone error in the language it was written in.
  const written = driver("let n = 3;\nlet total = 0;\nfor (let n = n; n > 0; n -= 1) { total += n; }\nconsole.log(total);\n");
  assert.match(written, /for \(double n_2 = n; n_2 > 0\.0;/);
  assert.doesNotMatch(written, /for \(double n_2 = n_2;/);
});

test("a name the driver binds in a condition is declared under a name of its own", async () => {
  // A float condition is a statement expression that binds the value it tests
  // twice, and it binds it under `blaze_truth`. A source name spelled that way
  // was not escaped, so inside the condition the program read the temporary
  // rather than its own value, and the loop ran on a double nothing had set.
  const source = [
    "const a = new Float64Array([2, 4, 6]);",
    "let total = 0;",
    "let i = 0;",
    "let blaze_truth = 10;",
    "while (a[i]) { total += blaze_truth; i += 1; }",
    "console.log(total);",
    "",
  ].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "30\n");
});

test("Deno.args reads the arguments the program was given", async () => {
  // Deno hands a program the arguments alone, where node counts the program
  // and the file it runs before them. A benchmark written for one host is run
  // by this one without being rewritten, so the argument it reads has to be
  // the one it was started with: `Deno.args[0]` is what node writes at
  // `process.argv[2]`, and reading it as `process.argv[0]` handed the program
  // a zero and the benchmark answered nothing at all.
  const source = [
    "const n = +Deno.args[0];",
    "console.log(`n: ${n}`);",
    "console.log(`given: ${Deno.args.length}`);",
    "",
  ].join("\n");
  // Node is not the oracle here: it has no `Deno` to read, and what the two
  // print is what the source means rather than what node would have run.
  const { binary } = await linked(source);
  const delivered = run(binary, ["7"], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "n: 7\ngiven: 1\n");
});

test("an argument is read as the number the language reads it as", async () => {
  // A command line argument is text, and the source reads it by coercing it to
  // a number. The host reads each one once, before the program runs, and the
  // answer has to be the one the language gives: 0b101 is five and " 10 " is
  // ten, an argument that is not a number is NaN, and an argument the program
  // was not given is NaN as well. A host that answered 0 for a missing or an
  // unreadable argument handed the program a value the source never wrote, and
  // a benchmark that reads its size was handed a benchmark that computes
  // nothing.
  const source = ["const given = Deno.args.length;", "const n = given > 0 ? +Deno.args[0] : 0;", "console.log(`${n}`);", ""].join("\n");
  const { directory, binary } = await linked(source);
  // Every argument the language spells differently from a C library, plus the
  // two the host has to settle for itself: one it was not given, and one that
  // is not a number at all.
  const cases = [
    ["10"],
    ["abc"],
    ["5x"],
    [" 10 "],
    ["0x10"],
    ["0b101"],
    ["0o17"],
    ["-0"],
    ["Infinity"],
    ["-Infinity"],
    ["+0x10"],
    ["1_000"],
    ["0x"],
    [""],
    [".5"],
    ["."],
  ];
  for (const arguments_ of cases) {
    const original = run("node", ["--import", DENO_PRELUDE, "main.ts", ...arguments_], { cwd: directory, timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    const delivered = run(binary, arguments_, { timeoutMs: 60_000 });
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout, `the argument ${JSON.stringify(arguments_[0])} reads as one number`);
  }
  // No argument at all is the case the host settles alone, and it is what a
  // benchmark started without its size does.
  const empty = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, "0\n", "the program was given no argument to read");
});

test("a length the program settles on that is not a number is no length", async () => {
  // A NaN reaches a length exactly where a program reads its size from the
  // command line and was given nothing to read. The language reads it as no
  // length at all, which is zero, and a cast of a NaN to an unsigned type is
  // whatever the machine made of it: the largest size there is, and an
  // allocation of that ended the run on a fault.
  const source = [
    "const n = +Deno.args[0];",
    "const block = new SharedArrayBuffer(8 * n);",
    "const a = new Float64Array(block, 0, n);",
    "let total = 0;",
    "for (let i = 0; i < n; i++) total += a[i];",
    "console.log(`${n} ${total}`);",
    "",
  ].join("\n");
  const { directory, binary } = await linked(source);
  const original = run("node", ["--import", DENO_PRELUDE, "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, "a NaN length must not fault the run");
  assert.equal(delivered.stdout, original.stdout);
});

test("a whole number the source wrote as a bigint is whole to the width it was resolved at", async () => {
  // `1 << 62` is a shift x86 masks to 5 bits, so a 64 bit whole operator over
  // literals written as bare C ints is evaluated at 32 and the program prints
  // 1073741824 where the source prints 4611686018427387904.
  const source = "console.log(1n << 62n);\n";
  const { binary } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "4611686018427387904\n");
});

test("a program that counts to a length prints what the source prints", async () => {
  const source = [
    "const a = new Float64Array([1, 2, 3]);",
    "let total = 0;",
    "for (let i = 0; i < a.length; i++) { if (i % 2 === 0) total += a[i]; }",
    "console.log(total);",
    "",
  ].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  // The even indices are 0 and 2, so the total is a[0] + a[2] = 1 + 3.
  assert.equal(delivered.stdout, "4\n");
  assert.equal(delivered.stdout, original);
});

test("a null interpolated in a string is the word for it, not a zero", async () => {
  const { binary, original } = await deliver("console.log(`v=${null}`);\n");
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "v=null\n");
  assert.equal(delivered.stdout, original);
});

test("a string interpolated in a string is the string, not the address of it", async () => {
  // The contract type language has no string type, so a string value has no
  // type and every interpolated value was written through the number path:
  // the pointer was cast to a whole number and the delivered program printed
  // where the string lived in memory in place of the string.
  const cases: readonly [string, string][] = [
    ["const s = `hello`;\nconsole.log(`value ${s} end`);\n", "value hello end\n"],
    ["const s = `a` + `b`;\nconsole.log(`v=${s}`);\n", "v=ab\n"],
    ["const s = `x`;\nconsole.log(`${1} ${s}`);\n", "1 x\n"],
    ["const c = true;\nconst s = c ? `yes` : `no`;\nconsole.log(`[${s}]`);\n", "[yes]\n"],
  ];
  for (const [source, expected] of cases) {
    const { binary, original } = await deliver(source);
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, expected, `for ${JSON.stringify(source)}`);
    assert.equal(delivered.stdout, original);
  }
});

test("a name the driver's own headers define is declared under another one", async () => {
  // `bool` is the _Bool of <stdbool.h> and `size_t` a typedef, so declaring
  // either of them is C the compiler turns away.
  const source = ["let bool = true;", "let ok = false;", "let size_t = 7;", "console.log(bool, ok, size_t);", ""].join("\n");
  const written = driver(source);
  assert.match(written, /\bbool bool_ = true;/);
  // The declaration is written at the type the source infers, and a number in
  // a program is a double, so only the name is pinned here: what matters is
  // that it is not the `size_t` <stdlib.h> already defines.
  assert.match(written, /\bsize_t_ = 7\b/);
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "true false 7\n");
  assert.equal(delivered.stdout, original);
});

test("text a strict C standard would rewrite as a trigraph survives to the binary", async () => {
  // The generated C is built with `-std=c11`, which replaces `??!`, `??=` and
  // the other trigraphs in translation phase 1, before the source is tokenised.
  // An unescaped `?` is therefore silent corruption: the build succeeds with
  // no diagnostic and the binary prints text the program never said.
  const { binary, original } = await deliver('console.log("really??!", "a??=b", "x??-??=");\n');
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "really??! a??=b x??-??=\n");
});

test("a parameter named after a C type or keyword is declared under another name", () => {
  // The extern declaration is the one place a program's own parameter names
  // reach the C source, and it is the one place they were not escaped. An
  // unescaped `double` is a type, so the declaration reads
  // `double twice(double double)`, which gcc rejects, and the whole program
  // build dies with a link failure.
  const files = {
    "twice.ts": "export function twice(double: number): number {\n  return double * 2;\n}\n",
    "main.ts": ['import { twice } from "./twice.ts";', "console.log(twice(21));", ""].join("\n"),
  };
  const phase = phaseOf("typescript", files, "main.ts");
  assert.ok(phase.body !== undefined);
  const written = generateProgramDriver(resolveProgram(phase.body, phase.program));
  assert.match(written, /extern double twice\(/);
  assert.doesNotMatch(written, /\bdouble double\b/);
});

test("a name the driver declares for itself is not given to a program name", () => {
  const written = driver(
    [
      "let program_string = 1;",
      "let blaze_rt_allocate = 2;",
      "let main = 3;",
      "console.log(program_string, blaze_rt_allocate, main);",
      "",
    ].join("\n"),
  );
  assert.match(written, /\bprogram_string_ = 1\b/);
  assert.match(written, /\bblaze_rt_allocate_ = 2\b/);
  assert.match(written, /\bmain_ = 3\b/);
});

test("an alias of an array is the array, at the element type the call reads it at", () => {
  const files = {
    "take.ts": "export function take(x: Int32Array): number {\n  return x[0];\n}\n",
    "main.ts": [
      'import { take } from "./take.ts";',
      "const a = new Int32Array([1, 2, 3]);",
      "const b = a;",
      "console.log(take(b));",
      "",
    ].join("\n"),
  };
  const phase = phaseOf("typescript", files, "main.ts");
  assert.ok(phase.body !== undefined);
  const written = generateProgramDriver(resolveProgram(phase.body, phase.program));
  // One array is written down once, at the type the call reads it at, so the
  // pointer is never read back silently as another type.
  assert.match(written, /int32_t\* a = /);
  assert.match(written, /int32_t\* b = a;/);
  // The count is over the program body: the driver prelude allocates in
  // `program_concat`, which is in every driver and says nothing about `a`.
  assert.equal((written.slice(written.indexOf("int main(")).match(/blaze_rt_allocate/g) ?? []).length, 1);
});

test("an array read at two element types is refused, alias or not", () => {
  const files = {
    "wide.ts": "export function wide(x: Float64Array): number {\n  return x[0];\n}\n",
    "narrow.ts": "export function narrow(x: Int32Array): number {\n  return x[0];\n}\n",
    "main.ts": [
      'import { wide } from "./wide.ts";',
      'import { narrow } from "./narrow.ts";',
      "const a = new Int32Array([1, 2, 3]);",
      "const b = a;",
      "console.log(wide(b), narrow(b));",
      "",
    ].join("\n"),
  };
  const phase = phaseOf("typescript", files, "main.ts");
  assert.ok(phase.body !== null);
  const refused = diagnostic(() => resolveProgram(phase.body!, phase.program));
  assert.match(refused, /an array of (f64|i32) is used where/);
});

test("a name the emitter writes a temporary under is declared under another", async () => {
  // A short-circuit arm that is a call is written out once, into a temporary
  // the emitter names for itself. A program that declares `value_1` and then
  // reaches that temporary was one name declared twice in the C, and the
  // initializer read the one that had not been given a value yet.
  const source = ["let value_1 = 7;", "console.log(Math.max(1, 2) > value_1 && value_1 < 9);", ""].join("\n");
  const written = driver(source);
  const declared = written.split("\n").filter((line) => /\b(?:double|bool) value_1\b/.test(line));
  assert.equal(declared.length, 1, written);
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
});

test("a for-of element that shadows the buffer reads the buffer, not itself", () => {
  // The buffer is read in the scope the loop was entered in. Read after the
  // element is declared, an element under the buffer's own name made the
  // loop subscript the element it had not taken yet, and the initializer
  // read a variable that was still uninitialized.
  const written = driver("const a = new Float64Array([1, 2, 3]);\nfor (const a of a) console.log(a);\n");
  const element = written.match(/const double (a_\d+) = (\w+)\[i\d+\];/);
  assert.ok(element !== null, written);
  // The element is written under a name of its own (`a_2`) and the initializer
  // reads the buffer (`a`). Before the fix the element shadowed the buffer, so
  // the initializer read the element itself.
  assert.deepEqual(element.slice(1), ["a_2", "a"]);
});

test("a short-circuit over two strings is the string it hands back", async () => {
  // `&&` and `||` hand back one of their arms, so a pair of strings is a
  // string. Typed as a truth it was refused by the validator with a diagnostic
  // naming a type the source never wrote, and the program could not be built
  // at all — the function lowering has always answered this one `text`.
  const source = 'let s = "";\ns = "a" && "b";\nconsole.log(s);\n';
  assert.deepEqual(semanticIrProblems(resolved(source), phaseOf("typescript", { "main.ts": source }, "main.ts").program), []);
  // The arm that decides is the string the source wrote, and the one it hands
  // back is the other: a truth over two strings would have been refused, and a
  // number would have printed the wrong one.
  const written = driver(source);
  assert.match(written, /s = \(\(\("a"\)\[0\] != '\\0'\) \? \("b"\) : \("a"\)\);/);
  const { binary, original } = await deliver(source);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.stdout, original, "the delivered program prints what the source prints");
  assert.equal(ran.stdout, "b\n");
});

test("`!` over a reference is the null test, and over a number is refused", async () => {
  // `!a` asks whether a reference is nothing, which is `is_null` and not a
  // truth. Lowered as `unary not` it named a bool the source never wrote, and
  // the validator refused the program — the function lowering has always
  // answered it as the null test, and `x === null` in a program still does.
  const reference = [
    "function make(v: number): any {",
    "  return { left: null, right: null, value: v };",
    "}",
    "",
    "const t = make(1);",
    'if (!t) { console.log("empty"); } else { console.log("has"); }',
    "",
  ].join("\n");
  const problems = semanticIrProblems(resolved(reference), phaseOf("typescript", { "main.ts": reference }, "main.ts").program);
  assert.deepEqual(problems, [], "a program that tests a reference for nothing is one the compiler may lower");
  assert.match(driver(reference), /\(t\) == NULL/, "and it is lowered as the null test");
  // A number is not a truth, and saying `!` over one is a mistake the program
  // should be told about rather than lowered into a negation of a number.
  assert.match(diagnostic(() => resolved("let n = 3;\nif (!n) { console.log(0); }\n")), /`!` needs something that is a truth/);
});

test("a string is ordered by what it says, not by whether it matches", async () => {
  // A model writes the artifact, so the emitter has to be right about a
  // comparison a source would not let it write. Every operator but `eq` and
  // `ne` was answered with the equality test, so `"apple" < "banana"` printed
  // false: the two are not the same text, which says nothing about which one
  // comes first. The function emitter has always used `strcmp` for this.
  const source = 'let a = "apple";\nlet b = "banana";\nconsole.log(a === b);\n';
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.match(generateProgramDriver(resolveProgram(phase.body!, phase.program)), /program_string_equal/, "an equality is still an equality");
  const turned = parseSemanticProgram(
    [
      'ir 1',
      'file "main.ts"',
      "",
      "block entry: releases[]",
      '  let text a mutable = [text "apple"] @1',
      '  let text b mutable = [text "banana"] @2',
      "  print_text [to_text [lt[bool] text local[text] a local[text] b]] @3",
      "  print_newline @3",
      "return",
      "",
    ].join("\n"),
    phase.program,
  );
  assert.deepEqual(semanticIrProblems(turned, phase.program), [], "the artifact is one the compiler may lower");
  const directory = await mkdtemp(join(tmpdir(), "blaze-order-"));
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await mkdtemp(join(tmpdir(), "blaze-runtime-"))).then((built) => built.objectPath);
  const runner = await buildProgramDriver({
    mode: "debug",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    program: turned,
    workDirectory: directory,
    objectPaths: [],
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  const ran = run(runner.command, [], { timeoutMs: 60_000 });
  assert.equal(ran.stdout, "true\n", "apple reads before banana");
});

/**
 * The compiler's own sources, measured against the TypeScript subset.
 *
 * A compiler that compiles itself starts with its own tree: every source that
 * makes the binary has to be a source the frontend reads. This test reads them
 * as the module graph a build reads — every file linked with the types, values
 * and signatures its imports bind — and reports what is still outside the
 * subset, so a slice that teaches the frontend one more construct shows up as a
 * lower number rather than as a feeling that progress was made.
 *
 * The budget is a ratchet, not a target. It is lowered by the change that earns
 * the lowering, and a change that adds a construct to the compiler raises it in
 * the same commit and says why.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selfHostGap } from "./self-host-gap.ts";

/**
 * The refusals the compiler's sources earn today.
 *
 * It was 6339 when the report was added, 6248 after the type-only slice, and
 * 6313 when the platform boundary added its two sources. Object shorthand and
 * the text methods lowered it to 5856, and reading a module's own top-level
 * values lowered it to 5802. Reading a file of declarations as a library rather
 * than a program rose it to 6298: functions that used to be read by the program
 * parser are now module functions, and the gaps in them are the ones the report
 * should show. Reading `Object.keys` and `Object.values` of a constant object
 * lowered it to 6280, and a for-of over an expression, a parameter written as a
 * pattern and a trailing comma in a list lowered it to 5194. A for-of that names
 * the parts of its element lowered it to 5123, a getter to 5121, and reading the
 * `_` separator in a number to 5068, and a block written as a statement to 4723.
 * Reading an `await` written as a statement lowered it to 4691, and carrying an
 * array as a value of its own — returned empty, held in a class field, or
 * grown through the field — to 4513, and a declaration that states its type and
 * no value to 4489, and a `for (;;)` loop to 4405. Reading the methods written
 * after one whose result is an object type raised it to 5505: the class scanner
 * had taken the type's brace for the body, so those methods were never read and
 * the gaps inside them were never counted. Reading `at` and `slice` of an array
 * lowered it to 5496, reading a regular expression — its pattern, its flags, and
 * the methods that read a text with it — to 5319, and carrying an interface or a
 * type alias through the module graph to 5091: a field of a named interface is
 * the type its declaration gives it, so the member chain after it is read.
 * Reading a call at the type its declaration writes for the result, `JSON`,
 * an optional chain over a computed position and a nested type argument lowered
 * it to 3162. Diagnostic recovery — one refusal per statement, and reading on to
 * the end of a refused statement — lowered it to 1927, because the number had
 * been measuring how far a parse got rather than what was missing. The two
 * parser bugs the recovery made landable — a return type's brace read as the
 * body, and a regular expression in an interpolation read as text — raise it to
 * 1981: both let a file be read that was not read before, and what they expose
 * is real work. Lower it with every slice; raise it only when the measurement
 * changes which parser reads a body, or when the compiler itself grows a
 * construct the frontend has not learned yet. A declared function read as the
 * value a collection method takes lowered it to 421. Reading the linked module
 * graph — the same two-pass read a build makes, with every file of the tree a
 * root — lowered the buckets that were only waiting for an import: a map built
 * from a field another file types, `Object.values` of a value another file
 * exports, and `new Date()` all read whole once the graph links them. It also
 * raised the whole to 2218, because an unlinked read stops counting at the
 * first imported type it cannot resolve: everything after that type was
 * deferred, so 421 measured how far a parse got rather than what is missing.
 * The linked read binds those types and reports what survives, and that is the
 * number the queue is now spent against. Reading a union laid out with the bar
 * the first member is written after lowered it to 1841: the bar was read as a
 * member that is `any`, and a union whose first member is `any` erased, so the
 * IR's own `SemanticValue` — a union of twenty-odd shapes written one per line —
 * was `any` and every member read through it was a method of nothing. Keeping
 * the one expansion of a declaration a table makes, which the link invalidates,
 * is what made the corrected reading affordable: the standalone read of the same
 * tree took five minutes without it. Carrying the classes another module
 * declares across the link lowered it to 991: `toolchain/ir-machine.ts` was 859
 * refusals on its own, almost all of them `this.code.movRegReg(...)` on an
 * instance of `toolchain/x86.ts`'s `Encoder`, and a class is now described to
 * the files that import it. Keeping the shape a collection's value was written
 * at — what `values()` and `get()` answer a field read through — lowered it to
 * 945, and keeping the signatures an exported declaration offers when its own
 * module is refused lowered it to 916: a file that calls one is read against
 * the parameters and result the declaration writes. Reading a `readonly` field
 * of an inline object type as the field it names lowered it to 903, and the
 * type a method writes for its result to 857, and a module that re-exports
 * another module's names to 847, and a closure a layout field holds to 725: an
 * arrow is a reference and a function-typed field is called through the value
 * it holds, reading a top-level constant at the type its declaration writes
 * lowered it to 698, a default read at its parameter's type to 689, and the
 * type an exported constant offers to 680, and reading every call's arguments
 * at the type the declaration states to 622, and the shape a value has across
 * the arm of a conditional to 609, a view of a block to 602, a whole number of
 * sixty-four bits to 580, the field a conditional spread leaves out to 574, and
 * the error stream to 566, the monotonic clock to 559, the record a
 * collection's element is to 548, and the members `Extract` and `Exclude` name
 * to 537, the list a narrowed value is, with the record a spread names, to 529,
 * a type a module re-exports to 518, an object written into a list to 515, the
 * type a top-level allocation writes to 509, the element a list method answers
 * to 494, a string that is not a bracket to 488, a key that asks a dictionary
 * to 485, the record an arrow answers, with the element's shape across a spread
 * and a text helper that is a read, to 480, the infinities, the greatest of
 * a list, a compound length, a local `undefined` and a bracket in a constant to
 * 472, a field through a reference, with the shape an assignment reads, a
 * for-of over a constant, a key held in a name, `Array.from` and the gate the
 * benchmark's own lowering writes to 447, and a string that is not a bracket,
 * with a function type read as the signature it is and a class carried across a
 * type-only import or a re-export, to 432, and an arrow's default, a typed loop
 * index, a padded text and the shape a slice keeps, to 428, and a coalesce that
 * keeps a collection, `Object.is`, a hex text and a re-export, to 415, and a map
 * of lists, a declaration read before it is written, a push on an element and
 * `slice()`, to 359, and a conditional spread that writes the zero of the field
 * it leaves out, to 341, and a map under a number key, a window of a block and
 * the bytes of a text, to 319, and the clock with a text decoder's bytes, to
 * 306, a method of an object literal with the element of a field to 299, and a
 * wrapped whole number with the default order and a view of part of a block to
 * 290, a conditional spread into a union of shapes to 271, and a push on a
 * choice of two places with the keys of a layout to 265, and an await that
 * holds the record its promise carries to 261, and a map of the pairs a
 * callback writes to 251, a map that answers a list to 246, and a record spread
 * into a record to 241, a rest field to 236, a spread whose value the read does
 * not shape to 231, an empty list a loop walks beside a set to 221, the module
 * graph read after the modules it imports to 220, and a spread of a call with a
 * method of a class another module declares to 213, and a hash that is the
 * runtime's SHA-256 hasher to 206, and a record built from a callback's pairs,
 * to 204, and an arrow the use holds at a function type to 203, and a record rebuilt
 * from the entries of a record, to 200, and an object spread in a program
 * body to 198, the await of a call through an interface member to 197, and Promise.all settling a list into the values it carries, to 196, Date.parse reading a date text back to 194, and a list reversed where it lies to 192, and a spread standing beside a value in Math.max to 191, and a text replacing the asking of its needle to 189, and a text split at most as many fields as its limit names to 188, and a union keeping the records it mixes with its values to 187 (and the debug print that had been left behind leaving once removed),
 * and a program that walks a value that is not a bare name to 181, and a text searched backwards to 180, and a list of lists flattened to 179, and a promise that answers nothing to 178, and the entries of a source assigned into a dictionary to 177, and a for loop whose step is an assignment to 176, and an async method of an object literal to 178 (it reads the methods after it, which are real work), and a map entry written as an asserted tuple to 176, and the captures a pairs callback reads to 171, and entries sorted (the valueKey statement still refuses for its replacer) and a typed array built from a list of numbers to 170, and a number question over a maths read and a whole number wrapped from a whole number to 166, and a text read at a byte position to 165, and a nested map a class field writes to 163, and a number read in its radix and a text of a code point to 161, and a text spread into a list with `Array.from` of one, a place behind a call written once, and `Object.hasOwn` of a constant record to 157, and a choice of two text reads to 155, and a push on the list an indexed field holds to 154, a statement that begins with a bracket to 153, and the collection bindings one function writes left out of the next to 152, a text encoder to 148, and a buffer read as floats with the elements a spread writes to 143, `Buffer.from` and its latin1 text to 141, and a record keyed by the numbers a source computed to 139, and a length written through a field of a field to 138, and a copy `structuredClone` makes is the value it copies to 136, a program asking the kind of a value to 135, and a pattern naming the elements of a value to 134, and a whole number written in base two to 133, and a list joined with a value, and a `for await` loop, to 132, and a call of what a call answered to 131, the host's directory entry and path work read as the compiler's own types to 124, and a class built on another to 123.
 */
const REFUSAL_BUDGET = 123;

/** One read of the tree, shared by the tests that read the report. */
const measured = selfHostGap();

test("the compiler's own sources are measured against the TypeScript subset", async (t) => {
  const report = await measured;

  t.diagnostic(
    `self-host: ${report.clean.length} of ${report.files.length} sources read, ` +
      `${report.refused.length} refused, ${report.total} refusals`,
  );
  for (const kind of report.refusals.slice(0, 10)) {
    t.diagnostic(`${String(kind.count).padStart(5)}  ${kind.message}  (e.g. ${kind.files[0]})`);
  }

  assert.ok(report.files.length > 0, "the compiler has sources to read");
  assert.equal(
    report.files.length,
    report.clean.length + report.refused.length,
    "every source is either read or refused",
  );
  assert.ok(
    report.total <= REFUSAL_BUDGET,
    `${report.total} refusals is more than the budget of ${REFUSAL_BUDGET}: a slice lowered it, so lower the budget, or the compiler grew a construct the frontend does not read`,
  );
});

test("a source that is refused says why, and one that is read says nothing", async () => {
  const report = await measured;
  for (const refused of report.refused) {
    assert.ok(refused.count > 0, `${refused.path} is refused and counts at least one construct`);
    assert.ok(refused.messages.length > 0, `${refused.path} is refused without a reason`);
  }
  for (const clean of report.clean) {
    assert.ok(report.files.includes(clean), `${clean} is a source of the compiler`);
  }
});

test("the sources that make the compiler are not the tests, the benchmarks or the scratch programs", async () => {
  const report = await measured;
  for (const path of report.files) {
    assert.doesNotMatch(path, /^(test|bench|scratch)\//, `${path} is not compiled into the compiler`);
    assert.doesNotMatch(path, /(^|\/)node_modules\//, `${path} is a dependency, not a source`);
    assert.doesNotMatch(path, /(^|\/)\.blaze\//, `${path} is a build's output, not a source`);
  }
});

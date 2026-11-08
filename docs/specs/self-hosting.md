# Blaze compiling Blaze

## What it is

Today `blaze` is a TypeScript program run by Node: `src/compiler/cli.ts` and the
modules under it. Self-hosting means a `blaze` binary, produced by Blaze from
that same tree, that builds the next `blaze`. It is not a second compiler written
in another language and it is not a rewrite of the programs Blaze compiles: the
source of the compiler is the input, and the tests are the same tests.

The definition of done is a fixed point:

1. The Node compiler builds `blaze-1` from `src/compiler`.
2. `blaze-1` builds `blaze-2` from the same tree.
3. `blaze-2` builds `blaze-3`, and `blaze-2` and `blaze-3` answer the same on
   the conformance corpus.

Byte-for-byte equality of the binaries is not required — a path, a timestamp or
a linker's own ordering may differ — but the build records, the selected
candidates, the IR text and the programs the compiler builds must agree. A
difference is either a bug in the native compiler or a non-determinism the Node
compiler still has, and both are worth fixing.

Two constraints follow from the goal.

- **No name is special.** A file is not compiled because it is the compiler's
  own file, and a function is not trusted because the compiler wrote it. The
  compiler that is running is an ordinary input to the compiler that is building.
- **The source is the specification.** Where the language and the compiler
  disagree, the frontend refuses the construct with a reason. It does not guess,
  and it does not replace source text with something that happens to work.

## The ladder

Self-hosting is reached in rungs, and each rung is a test that can be run before
the next one exists. The order is deliberate: every rung adds one host service
or one language capability that the rung below it does not need.

| rung | what runs | what it proves |
|---|---|---|
| 0 | `blaze --help`, `blaze projects` | argv, exit status, stdout and stderr, and reading a directory |
| 1 | `blaze ir` on a project | the frontend, the contract phase, the semantic IR and JSON |
| 2 | `blaze build --model replay` on a library | code generation, the assembler, the linker and spawning a toolchain |
| 3 | `blaze build` on a program | the program body, the runtime and running the delivered binary |
| 4 | `blaze build` on `src/compiler` | the whole compiler, including its own module graph |
| 5 | `blaze-2 build` on `src/compiler` | the fixed point |

Rung 4 is the hard one. Everything before it is a smaller compiler with the same
frontend, IR and backends.

## Where the source stands

The compiler is 94 non-test, non-benchmark, non-scratch TypeScript sources, about
100,000 lines. It is already written as **erasable TypeScript**:
`erasableSyntaxOnly` is on in `src/compiler/tsconfig.json`, so no `enum`,
`namespace`, parameter property or `import =` carries runtime behaviour. Every
`interface`, type alias, generic, `as`, `satisfies` and `import type` can be
erased by the frontend rather than modelled by it. That is the cheapest large
slice available, and it is why the type layer is first below.

The gap is measured, not guessed: `test/self-host.test.ts` reads the sources as
the module graph a build reads and holds the refusal count as a budget. When the
report was added, 1 of the 91 sources (`semantics/module.ts`, which is types
alone) was read and 6339 constructs were refused. The type-only slice below lowered the count to 6248.
The platform boundary added two sources that are values and re-exports, which
raised it to 6313: the compiler is now 93 sources, and 1 is read. Object
shorthand and the text methods lowered it to 5856, and reading a module's own
top-level values lowered it to 5802. Reading a file of declarations as a library
rather than as a program rose it to 6298: functions that used to fall to the
program parser are now module functions, so the report shows the gaps in them.
Reading `Object.keys` and `Object.values` of a constant object lowered it to
6280. Reading a `for..of` whose body names an expression rather than an array
name, a parameter written as a pattern, and a trailing comma in a list lowered
it to 5194, a `for..of` that names the parts of its element lowered it to 5123,
a getter to 5121, the `_` separator in a number to 5068, a block statement to
4723, an `await` written as a statement to 4691, an array returned empty or
held in a class field to 4513, and a declaration that states its type and no
value to 4489, and a `for (;;)` loop to 4405. Reading the class methods written
after one whose result is an object type raised it to 5505: the scanner had
taken the type's brace for the method body, so those methods were never read.
Reading `at` and `slice` of an array lowered it to 5496, reading regular
expressions to 5319, carrying interfaces and type aliases through the module
graph to 5091, reference-valued maps and sets to 4824, expected types for
empty lists to 4680, the type of each name a destructuring pattern binds to
4595, and the type of a collection callback's parameters from the array it
walks to 4584, splitting a text into the fields a separator cuts and pushing
several values at once to 4579, the type and shape a `??` keeps to 4542, and
object spread of a typed object, `Omit`/`Pick`, a class field's annotation in
every form the language writes, a field assignment read at the field's type,
an empty list at a type an import declares to 4251, folding a text to lower or
upper case to 4245, `extends Error`/`super`, `instanceof Error` and a class
another module declares to 4179, a method written on a field of an imported
type — which waits for the read that follows the link rather than being refused
on the first — to 3918, a record keyed by text and a generic annotation in a
program to 3879, an array the file writes down to 3853, a loop over the entries
of a record to 3852, a method on a class field written at an imported type to
3322, the number questions to 3299, a call of a method at the type its
declaration writes to 3265, `JSON` to 3234, an optional chain over a
computed position to 3201, a nested type argument to 3168, and the line an
interpreter opens a file with to 3162, with `core/errors.ts`,
`semantics/contract-build.ts`, `semantics/diagnostics.ts`,
`semantics/language.ts` and `toolchain/wasm-host-runtime.ts` read as wholes.
Reading every source as the module graph a build reads raised the number to
2218 — a file read on its own stops counting at the first imported type it
cannot resolve, so the old number measured how far a parse got — a union
laid out with the bar its first member is written after lowered it to 1841,
and carrying the classes one module declares to the files that import them
lowered it to 991, what a collection's value holds to 945, and the signatures a
refused module still offers to 916, and a field a modifier is written in front
of to 903, and the type a method writes for its result to 857, a module that re-exports to
847, a closure a layout field holds to 725, and the type a top-level declaration
writes to 698, a default read at its parameter's type to 689, the type an
exported constant offers to 680, and the type a call reads its arguments at to
622, the shape a value has across the arm of a conditional to 609, a view of a
block to 602, a whole number of sixty-four bits to 580, the field a conditional
spread leaves out to 574, the error stream to 566, the monotonic clock to 559,
the record a collection's element is to 548, and the members `Extract` and
`Exclude` name to 537.
The sources read whole are now `ai/model.ts`, `core/errors.ts`, `core/ir.ts`,
`core/semantic-ir.ts`, `core/types.ts`, `runtime/http-needs.ts`,
`semantics/builtins.ts`, `semantics/contract-build.ts`,
`semantics/diagnostics.ts`, `semantics/language.ts`, `semantics/module.ts`,
`toolchain/wasm-host-runtime.ts` and `util/source.ts`.
The refusals fall into six frontiers:

- **Type-only syntax.** Most of it is already carried, and an interface or an
  alias is no longer just erased: its fields type the member chain written
  through it, and a declaration imported from another module is read in the
  module that wrote it. A file is first read before its imports are linked, so
  an empty list, an object spread or a method written on a value or a class
  field of an imported type is left to the read the module graph makes once the
  declarations are bound; that read settles it, and reports what is still
  unsettled. A refusal written on any other value is still refused by the first
  read.
  `Omit<T, "k">` and `Pick<T, "k">` select the fields of the record they name,
  which is how a type is written when
  a function takes a subset of a declaration's fields. The remaining
  type-shaped refusal is the optional parameter, which needs an absent value the
  value model does not have yet.
- **The JavaScript expressions the source uses.** Optional chaining (`?.`),
  nullish coalescing (`??`), spread, destructuring (declarations, parameters and
  assignment), object shorthand, `switch`, `throw`, class getters and regular
  expression literals, and the module forms (`import * as`, renamed imports,
  re-exports). A destructured name is now held at the element or field type of
  the value it reads, so the methods written on it are read too; a rest element
  and a nested pattern are still refused because they need a slice or a shape
  the pattern does not name yet. A class may name `Error` as its one base:
  `super(message)` writes the message the base holds, `instanceof Error` is the
  class check it is for a class of the module, and `new C(...)` of a class
  another module declares calls the constructor that module lowered. `typeof`
  answers from the type of a member, an element or a call as well as a name.
  `Number.isNaN`, `isFinite`, `isInteger` and `isSafeInteger` are written out
  of comparisons and a floor, and `MAX_SAFE_INTEGER`, `MIN_SAFE_INTEGER` and
  `EPSILON` are numbers the source writes down. A call of a method, a getter or
  a static field is held at the type the declaration writes for its result, so
  the text methods written after one are read.
- **Values a module exports.** A top-level constant is read by the functions of
  its own file, where the value is written into the body. An array whose every
  element is written down is one of these, unless a body writes the name: a
  value a program changes is state rather than a constant. A value another
  module imports is not carried: the module graph still offers functions only,
  and `export const` in another file is refused at the import that names it.
- **The value model.** `JSON.stringify(value)` is the text a value is written
  as, and `JSON.parse(text)` is the dynamic value a document holds, which a
  number or a text position reads as the runtime's own reading of it. A list or
  an object written where the call is needs no dynamic value at all: the text is
  built from the values the source wrote, so a list may hold a text and a number
  in the same call and an object's field names are the ones it names. A list
  built while the program runs is still refused, because its JSON is not a text
  the parser can write. The compiler relies on `undefined`/absence, dynamic
  objects with text keys, maps and sets of references as well as numbers,
  arrays that grow, arrays of arrays, and text methods including regular
  expressions. A `Record<string, V>` is the dictionary a `Map<string, V>` is:
  an object literal at that type is one entry per field, `r[key]` reads one
  entry, `r[key] = value` writes one, `Object.keys`/`Object.values` walk the
  entries, `hasOwnProperty.call` asks the dictionary, and `Object.fromEntries`
  copies a map's entries. A `for (const [key, value] of Object.entries(record))`
  reads the two values of one entry straight out of the dictionary. An array of
  `[key, value]` pairs outside such a loop is still refused, because a compiled
  list holds one element type and a pair is two values of two types.
- **The host.** Before the boundary, 28 of the sources imported `node:*`
  directly: 66 imports, led by `fs/promises` (23), `path` (14), `fs` (8),
  `crypto` (8), `url` (6), `os` (3), `child_process` and a few others. They now
  import `core/platform.ts`, and `core/platform-node.ts` is the only file that
  names a Node module. The compiler also reads its own tree to fingerprint it
  (`core/version.ts`), so a native build needs the sources or the fingerprint at
  run time.
- **Packages.** `smol-toml` for project files, the Vercel AI SDK for model
  providers, and `zod` in one adapter. A native binary cannot import them from
  `node_modules`.

The frontend is a parser for a small program language, not a general JavaScript
parser. That is the right shape to keep: the goal is to grow the subset by
measured slices, not to become a second TypeScript implementation.

Two things about the number are worth knowing before a slice is measured
against it. **A refusal cascades**: the parser reads on after a construct it
cannot read, so one gap was often reported several times as the junk around it.
**Reading further raises the number**: a file whose functions used to fall to
the program parser is read as a library once the construct that sent them there
is carried, and its functions then report the gaps they always had. A slice that
reads more of a file can therefore raise the total while removing real work,
which is why the budget is a ratchet rather than a score and why a per-file
delta is read before a slice is accepted.

### 4a. Recover at the statement

Both parsers now recover at the statement, which is what makes the number a
measure of work rather than of how far the parse got:

- a statement reports **once**. `TypeScriptParser` and `ProgramParser` each keep
  a per-statement count, reset at the beginning of every statement and kept
  around the statements nested inside it, so a parent's refusal does not hide a
  child's and a child's does not repeat the parent's. The third method of a
  chain the module does not declare is the same gap as the first, read again;
- after a refused statement, the parser reads on to the **end of that
  statement**, found from where it began over the source's own brackets, so the
  next statement starts where the source wrote it. A `}` that closes a block the
  statement opened ends the statement, and the `else`, `catch`, `finally` and
  `while` after it are part of the same one;
- `ProgramParser.expect` reads on to the closing bracket it expected when it is
  missing where the source wrote it, so a header the expression grammar does not
  carry ends at its own `)` instead of leaving the body to be read as statements.

This took the total from 3162 to 1927. The same recovery in the module parser's
`expect` was measured too: it reads `cli.ts` almost whole (14 refusals to 3) but
raises the total by 189, because `toolchain/ir-machine.ts` and
`semantics/ir-function.ts` then report what was hidden from them. It is written
and held back until the gaps it exposes are carried.

Two parser bugs that the recovery made landable are fixed with it:

- `skipFunctionBody` found the body at the first `{` after the `)`, which is the
  *return type's* brace when the return type is an inline object, so
  `function f(): { buffer: string } | null {` ended the declaration at its type
  and the rest of the signature was read as a statement of the file, which made
  the file run and hid every function in it from the module reader. The
  annotation is now skipped as a type first (`FUNCTION_BODY_STOPS`: `{`, `=`,
  `;`). It reads `semantics/typescript-classes.ts` almost whole (12 refusals to
  6) and `compiler.ts`, `optimize-ir.ts`, `ir-machine.ts` and `ir-wasm.ts` by 19
  to 40 each; the files whose functions become readable report their own gaps
  (`ir-validate.ts`, `python.ts`, `repair.ts`) and the net is +2, which is the
  reading-further artefact just described.
- `closingBrace` desynchronised on a regular expression containing a quote:
  `x.replace(/"/g, …)` inside an interpolation made the brace matcher read the
  pattern's `"` as the start of a text, so the interpolation's `}` was never
  found and the file failed with `unterminated string`. A `/` where a value is
  expected is now read as the pattern it is. `toolchain/linker.ts` goes from 1
  refusal (`unterminated string`) to 15 real ones, and the frontend reading its
  own `semantics/typescript.ts` goes from 191 to 231; the net is +54, all of it
  the reading-further artefact.

### 4b. Carry the constant set and map

A top-level `const SEEN: ReadonlySet<string> = new Set(["a", "b"])` is not state:
the keys are written down, so nothing allocates it and nothing changes it. The
scanner now records the keys (and, for a `Map`, the value each was written
with) when every key is a literal and nothing adds to or removes from the name.
`SEEN.has(x)` is the disjunction of `x === "a" || x === "b"`, `MAP.get(k)` is
the conditional chain of the written values ending in the zero of the value
type, and `.size` is the count. The name is not a value the runtime holds, so a
function of the module that reads it stays a module function; before, it was
moved to the program parser and the name was read there. A set or map written
another way — built at run time, or added to after the declaration — is still
state. This took the total from 2004 to 1989.

A mutable top-level value (`let temporaryWrites = 0`, `let reading:
Promise<...> | undefined`) is still state with no place in the value model:
a module function has no environment to read it from, and the IR has no
storage a program holds across calls. The two in the compiler are read by a
function that is already a program function, so they cost nothing today; a
module-scoped global is the slice that would carry them, and it needs a slot
the linker can name.

### 4c. Spread a list into the call that takes it

A spread is the elements of a list written where values go, and the two places
the compiler writes one are a push and a call:

- `a.push(x, ...b)` is the list joined with each written value as a one-element
  list and each spread as the list it is, in the order the source wrote them —
  the concatenation two lists added are, which both backends already lower.
  `a.push(...b)` needs no helper at all. A spread anywhere else in a call is
  refused where it is, because the arguments it stands for are not known until
  the program runs;
- `f(...xs)` hands the function the elements of the list read by position, one
  per parameter the declaration states. A function whose parameters the read
  does not hold — one another module declares — cannot say how many elements
  the call takes, and is refused.

This took the total from 1989 to 1898. A rest element in a destructuring
pattern (`const [head, ...tail] = xs`) is still refused: the three in the
compiler are all in files with a bigger gap, and the bound name needs the
element type of a slice the pattern's own annotation states.

### 4d. The small items

- `text.trimStart()` and `text.trimEnd()` are the one end of a text, which is
  what cuts a line of a file apart: `trim` already took both ends, and the two
  are the runtime helpers the C runtime defines and the other targets import.
  The program grammar reads them too.
- `Number.parseInt(text, 10)` and `parseInt(text, 10)` are the number a text
  states, which is what `parseInt(text)` already reads; the radix is the one
  the language writes. Another base is refused where it is, because the runtime
  reads a decimal text and nothing reads a hexadecimal one.
- `parseInt` and `Number` had a lowering in the program emitter and none in the
  semantic-IR C backend, so a module function that read a number out of a text
  could not be built at all. The C backend now reads the number the value says,
  which is the same call the program emitter makes.

The rest of what this item named is not missing methods. `Array.find`, `some`,
`every`, `sort`, `join`, `map`, `filter` and their neighbours are all
implemented as functions of the file that walk the array; their refusals are
the receiver's element type not being known — a field of an imported interface,
or a value narrowed inside a `switch` on a union — so they are the type-flow
slice and not this one. `Array.isArray` and `Object.is` are questions about a
value that the runtime's dynamic kind could answer; neither is written yet, and
`Object.is` distinguishes `-0` from `0`, which needs the sign of a zero.

This took the total from 1898 to 1890.

### 4e. The element type through a chain

The walking methods — `map`, `filter`, `join`, `some`, `find` and the rest —
are all written as functions of the file; what refused them was never the
method but the receiver's element type. A chain is read left to right, so each
step has to answer the type the next one asks about. Three steps did not:

**`entries()` of a list.** `for (const [index, element] of list.entries())`
names two values, and a pair is not an element a typed array holds. The loop
now reads the list once before it starts and walks its positions from zero to
its length: position 0 of an entry is the index, held at a number, and position
1 is the element, held at the element type of the list. The receiver may be a
name or any expression, which is read into a name of the loop's own the same
way a walked collection is. A pattern that names anything else is refused where
it is written. This took the total from 1890 to 1879.

**A list built from a call's result.** `[...rest.map(f)]` was refused wherever
a method followed it: the pieces of a literal are joined with `+`, and the type
of a join is read from a name table that cannot see what a call answers. The
literal now records the element type it joined — and the shape that goes with
it, so a reference element is still read field by field — on the expression it
answers. A spread whose value is not a list (a call the module graph has not
linked yet reads as a deferred hole) states no element type, because a hole is
not evidence of what the list holds; the other pieces or the use settle it.

A set spread into a list is the keys it holds, read out by position with the
helper `keys()` already uses: a set is a dictionary, and the handle a name
holds is not an element a list holds. `new Set<string>([...seen, next])` is the
keys seen plus one more. This took the total from 1879 to 1855.

**A value asserted as a collection.** `groups.get(name) as Set<string>` names a
collection the value already is, and a map whose value is a set answers a
handle that says nothing about what it holds. The assertion is recorded as the
collection it names, so `has`, `add`, `delete` and `size` written after it are
the dictionary's own. An assertion written as a list records the element type
the same way, so `(record.names as string[]).join(…)` reads texts. This took the
total to 1851.

**`typeof` of a value the read cannot type.** `typeof` was answered from the
declared type, and a value the read has no type for — a field of an interface
the module graph has not linked, a parameter the source wrote `unknown` — was
called an object. That folded `typeof value === "string"` to false and compiled
no arm of the branch at all, which is the worst of both: no refusal, and no
code. The question is now asked at run time, of the value: the runtime answers
the kind it registered the value as, and a value it does not hold is a number,
or a text where the number is the pointer the text sits at. The answer is a
text, so the comparison the source wrote is the comparison the program makes.

The answer is only asked of a value whose *shape* the read does not hold: an
interface erases to a reference with no name, and so does `unknown`, but the
shape keeps the name of the interface a value was declared at. A concrete
`typeof named === "object"` is still answered where it is read.

**A test settles the branch it guards.** `if (typeof entry !== "string") throw
…; entries.push(entry)` is only code a compiler can type if the test is
remembered: past the guard the value is a text, and `entry.trim()` is a text
method. The tests a source writes over a value it does not know are
`typeof x === "kind"` and the two ways two of them are joined — a conjunction
settles both when it holds, a disjunction both when it does not — and a
negation swaps the two sides. The settled types are kept by the way the source
spells the chain (`entry`, `input.source`, `cb.name`), because a member read is
a new expression every time it is written, so the value itself cannot be the
key. Three places read them: the arms of a conditional, the right side of `&&`
and `||`, and — where the branch leaves the block by a `return`, a `throw`, a
`break` or a `continue` — the statements after the `if`. A block hands back the
table it was read with when it ends, and a name written to forgets what was
known about it.

Two things a narrowed value needed on the way to the backends. The machine
backend handed a dynamic value to the text runtime without carrying it as the
double the convention hands one over as, which read the bytes of nothing; and
the host of the WebAssembly backend wrote a parsed string as the quoted JSON of
it rather than as its text. Both are the same claim as the frontend's: a text
method reads the text the value holds.

**A name spelled `type`.** `type` is not a word the language keeps, but a
statement that began with the identifier of that spelling was refused as a type
declaration. Only a statement that writes a type alias is one; `type = null` and
`type.kind` read a value like any other name.

**`x.toString()` with no radix.** The hexadecimal form is `x.toString(16)`; with
no argument at all the value is written the way a template string writes it,
which is the digits of a bigint and the shortest decimal of a number.

This took the total from 1851 to 1779.

### 4f. A chain of methods on an imported type

An imported interface is the largest remaining source of refusals, and the
module graph already carries it: a file is read before its imports are linked,
the read that follows the link holds the declaration, and a method written on a
field of it is read against the field's own type. What did not survive the
link was a *chain*:

    driver.bodies.filter((body) => !covered.has(body.name)).map((body) => body.symbol)

`filter` was deferred, because `driver` is held at a declaration the read does
not have. What `filter` answers is a value of that same declaration — a list
whose element type is in the other module — and a method written on it was
refused as a method of nothing. Three things were missing.

**What a deferred method answers is deferred too.** The hole a deferral leaves
is marked as deferred, and `pendingHolds` answers true for a value that is one.
A method written on that answer waits for the same link.

**The callback waits with it.** A callback handed to such a method is handed the
element of a list whose element type the read does not hold: an element type
that erases to a reference with no name. A parameter the source did not annotate
is then a value the link will name, so it is marked pending and a text method
written on it is not refused here. This is also why an annotation is now read for
*every* name it mentions rather than for the name it starts with: `Name[]`,
`Record<string, Name>` and `Omit<Full, "c">` all name a declaration in another
module, and `Name[]` used to leave the file looking as if it imported no type at
all.

**A walked list keeps its element's shape.** `filter(f).map(g)` reads the fields
of an element twice, the second time through the list `filter` answered. The
type of that answer was recorded but its *shape* was not, so the second step was
field by field only for the element type it could still resolve by name — which
is nothing, for an element read out of another module. `collection` now records
the shape its answer holds: the receiver's element shape for `filter` and
`sort`, and what the callback answered for `map`.

This took the total from 1779 to 1719.

### 4g. The value a module offers

`OUTPUT_KINDS.includes(x)` reads a list another module wrote, and there was no
way for it to: a compiled function has no environment to read another module's
scope from, and an import brought in a name with nothing behind it. Types
already crossed the module graph; values now cross it the same way.

**What crosses is the value, not the name.** The file that writes
`export const KINDS: readonly string[] = ["c", "asm"]` reads the value where the
source wrote it — the scan already records every top-level `const` whose value
is written down rather than computed — and offers it to each module that imports
the name. A token range names nothing in a file that did not write it, so the
part that crosses is the expression, not the span: a constant carries either the
tokens this file wrote (`{ range }`) or the value the writing module already read
(`{ value }`), and never both.

**A constructor is the file's own.** `const CURVE = new Curve(…)` is inlined
where the file that wrote it reads it, and the constructor is a function of that
module: another module does not compile it, so the value is not offered. Only a
value written down crosses.

**The read that follows the link is the one that answers.** A name an import
binds is a value another module holds, so a method written on it is not a method
this read can say does not exist, and the read waits for the link. The graph
reads such a file again once its imports are bound — including the file whose
imports turned out to hold nothing, because what it deferred is the link's to
answer one way or the other — and that read refuses what is really absent. A
read that stands alone, which is what the gap measurement makes, waits for a
link that may never come.

**A module of constants is a library.** A file that declares no function was
refused unless it wrote a type; a file that only writes constants is reached by
the imports that read them in the same way, and a name an import binds may be a
value the module offers.

Two files rise by one construct each — `core/terminal-title.ts` and
`toolchain/csource.ts` — and both are the reading-further artefact: a deferred
member read let the parser past a construct it used to stop at, and what it
reached is a real gap that was hidden behind the first refusal. This took the
total from 1719 to 1697.

### 4h. A number written in binary or octal

The bit fields an encoder is written with are binary — `(w ? 0b1000 : 0) |
(reg >= 8 ? 0b100 : 0) | 0b10 | 0b1` — and the scanner read `0b101` as the
number `0` followed by the name `b101`, which left the call it was written in
unclosed. A number written in base two or base eight is now the value it names,
written as the decimal every other number in the file is: `0b101` is `5` and
`0o17` is `15`, and `0b1111_0000n` is the bigint `240n`. The digits are what
the rest of the compiler reads, so nothing downstream changed. This took the
total from 1697 to 1688.

### 4i. A field of a field written

`this.frame().block.terminator = value` and `reading.needs.tls = true` are the
two shapes a field write takes in the compiler's own code, and the IR writes one
field of one *name*: `memberAssign` names a base and a field, and a chain of
three was outside it. The statement is now read as the write it is — the value
the field belongs to is read into a name of the loop's own, and the write goes
into that name. An object is a reference, so writing through the name is writing
the object the source named, and the value before the last field is evaluated
once, which is what the source wrote.

The one chain this does not take is a write to the `length` of a list or a text:
a list's size is the block the runtime allocated, and the source writes its
elements rather than its size. That is refused where it is written, as before.
This took the total from 1688 to 1674.

### 4j. A brace written inside a text

A string token's `text` is what the string *holds*, so `"}"` is a token whose
text is a brace. The scans that walk the tokens rather than parsing them —
`localNames`, the constant scan's bracket matching, `objectConstants`,
`constantList`, `collectionLiteral` — asked every token for its text and counted
that brace as one of the file's. The compiler's own source writes those texts in
`valueExpected`, where the depth left the file at `-1` at line 219 and never
came back: every top-level `const` after it was taken for a body's own name, so
the constants were not the file's and the function that reads one was refused.

Nothing that asks what a token *is* needed changing: the parser has always
checked a token's kind. The scans now ask `mark(token)`, which answers the
punctuation a token is and nothing for a value. This took the total from 1674 to
1591.

### 4k. `key in record`

`in` is one of the operators the source's control flow is built from — the
frontend's own scanner reads `source in PRIMITIVES` to decide what a type
annotation is — and it was not read at all: `return key in TABLE` was three
statements, a `return key`, a value named `in`, and a value named `TABLE`. That
was worse than a refusal, because it compiled.

`in` now binds where a comparison does, and asks the question an object's keys
answer. A record the file writes out — its own top-level constant, or one an
import binds — has the keys the source wrote, so the answer is the chain of
comparisons those keys are, exactly as a written set's `has` is. A value the
read holds at a record type answers `true` for a field its type declares, which
is the object it was laid out as.

What is not carried is the test a union of shapes is discriminated by. A union
erases to its first arm, so the field of another arm is not a field the read
knows the object has; answering `false` there would be a silent wrong answer, so
the construct is refused with that reason instead. `"k" in value` over a value
the read does not type is the same case. This took the total from 1591 to 1584.

### 4l. A value read twice

A written set's membership is the chain of comparisons its keys are, and every
comparison reads the value it was handed: `WORDS.has(x)` is `x === "return" ||
x === "if"`. That needs `x` to read the same way twice, which is why the parser
refuses a value it cannot read twice and asks the source to write it into a name
first. A text's own methods were not on that list, so the compiler's own scanner
could not write `WORDS.has(text.slice(start + 1, index + 1))` — a shape the
frontend's source is built from.

A call whose name is a text method's, over arguments that read the same way
twice, now does. No text method writes the text it reads, and the call is built
by the file's own helper, so asking one of them twice is asking the same
question; a method whose name is a helper's — `split`, or a regular
expression's `replace` — is not on the list. This took the total from 1584 to
1548.

### 4m. The value a write goes through may be a call

The IR writes one field of one name, and a chain of fields was lowered through a
name of its own; a chain with a *call* in it was not, so
`this.frame().block.terminator = value` — the shape the IR builder is written in
— was refused twenty times over. The write names the last field, and everything
before it is the value the field belongs to; that value is now read as the
expression it is, over the tokens before the last field, so a call and the
fields after it are read by the one reader that can build them. The value is
read into a name of the loop's own and the write goes into that name, so the
call is evaluated once, which is what the source wrote.

What is still refused is a write to the `length` of a list or a text, which is
the list's size rather than its elements. This took the total from 1548 to 1540.

### 4n. `Array.isArray`

The compiler asks whether a value it read from a build record or parsed from a
file is a list, and the question had no reading at all. It is settled where the
type is: a value the read holds at a list type is one, and a number, a truth, a
text or an object is not. What the read does not type — a tree a parse read, a
field of a module the graph has not linked — is asked of the runtime, which
already carries the kind and now has one entry that answers whether the handle
is an array. The C driver, the C backend, the wasm service and the Nim adapter
each answer it, the way they answer `blaze_rt_type_of`. This took the total from
1540 to 1529.

### 4o. A field of a type another module declares

A local interface may write a field at a type another module declares —
`interface ModuleRecord { analysis: ModuleAnalysis }` — and the first read does
not hold that declaration. What the field holds was `any`, so a method written
on the field's field, `record.analysis.imports.map(...)`, was refused as a
method of nothing, although the read that follows the link holds the
declaration and reads it.

The declaration's fields now carry the names their annotations write that the
table they are written in does not hold, so the reader can tell a name this file
imports from a type that really is `any`. A field written at one of those waits
for the link, as a value of an imported type already did.

The total held at 1529: the refusals did not go away so much as move behind the
construct they were hiding. `semantics/ir-validate.ts` rises by four — four
`Object.values` of a constant object, one `hasOwnProperty` of a record keyed by
text, both of which were standing behind a `map` over a field of an imported
type — and that is the reading-further artefact, not a new gap.

### 4p. `text.startsWith(needle, at)`

The compiler's scanners ask whether a text starts with something at a position —
`source.startsWith(candidate, index)` — and `startsWith` was carried for one
argument only. The two-argument form is the field the text holds from `at`: the
slice that runs as far as the needle is long, compared with the needle. Both
read the needle, which has to read the same way twice.

The one-argument form now takes the same reading, as the field from the
beginning, rather than asking where the needle is. That is not for the gap. A
guard that asks a text's index and is followed by another statement answers
garbage on the machine backend:

    let n = 0;
    if (text.includes("xx")) n += 1;   // the index in a condition
    if (n > 10) n += 10;
    return n;                          // the program answers NaN

The same guard with the call written into a name first is right, and so is the
same two guards over a number, so it is the call inside the condition rather
than the guards. `includes` is the one method that still asks the index; the two
`startsWith` forms now compare a slice. The bug is recorded as the next slice to
take, because a compiler whose scanners ask a text's index in a guard is exactly
the program the self-build is. This took the total from 1529 to 1521.

### 4q. The vector registers a call does not preserve

The reproducer of 4p is fixed, and it was not a parser fault at all.
`VECTOR_CALLEE_SAVED` in `toolchain/ir-machine.ts` is `xmm6` to `xmm15`, on the
comment "ten is what the convention has" — that is the Windows rule. This target
is System V AMD64, where **no** vector register is preserved by a call: every one
of `xmm0`–`xmm15` is the caller's to save. The allocator pinned a name in `xmm6`
across a call into the runtime, `strstr` wrote it, and the function answered
`NaN`. Machine code calling machine code was never wrong, because both sides
save the same registers; every call the runtime, the C library or the host serves
was exposed.

The fix is the one the convention states: around a call into code this backend
did not build, the vector registers that hold this function's values are written
down and read back. Which call that is, the lowering knows: a symbol this
backend built is in the program's `callable` set, and everything else — the
runtime, the C library, the host — is not. `MachineRequest` grew a `foreign` set
beside `callable` so a test that links its own C functions can say which of the
symbols it names are somebody else's; a build of a program passes none.

The slot the call writes is not the prologue's. That one holds the value the
caller had, which the epilogue has to give back, and a call-time save would write
this function's current value over it. So each pinned vector register gets a
second slot, and a call costs two instructions per register held — paid only by a
function that keeps a value in a vector register *and* calls out of its own
object.

Two tests hold it: `ir-machine.test.ts` runs a loop whose running total is live
across a call to a C function that writes all ten registers the backend used to
assume were its own, and `language-features.test.ts` builds the source shape —
five guards asking five text methods, one after another. Both fail with the save
turned off.

The total holds at 1521. This slice bought no refusals; it bought an answer that
was wrong.

### 4r. A class parameter of a type another module declares

Two small holes under the same refusal. A class parameter written at an imported
type was not marked as waiting for the link, so a method written on a field of it
was refused as a method of nothing, although the same read inside a plain
function waited and was read after the link. And a *property* parameter —
`constructor(private readonly names: Set<string>)` — declares a field as well as
a parameter, but `findField` only searched `info.fields`, where a property
parameter never appears, so `this.names.has(x)` was refused as an unknown method
of a value the read could not type. A property parameter is now found where the
field is written, which is what it is.

This took the total from 1521 to 1501, almost all of it in the files whose
classes take their collaborators as constructor parameters (`runtime/nim-program.ts`
reads whole, 6 to 0, and `toolchain/driver.ts` and `toolchain/ir-wasm.ts` lose
four each).

### 4s. `T["field"]`

`CandidateOutcome["failure"]` is how the compiler's own sources write the type of
a value they kept from a union — `failure` is `{ detail?: string; ... } |
undefined` — and the type reader read the `[` as the start of a tuple or a list,
so the annotation became `any`. Every method written on the value was then a
method of nothing: `failure.detail.trim()` was refused on the line the source
wrote it, although the `=== undefined` guard in front of it is exactly what makes
it a text.

An index written as a string literal is now read as the field it names, through
the same `fieldOfType` the member chains use, and an index into a list, a map or
a set is the element of one. The total is flat at 1501: the declaration the names
are written on is another module's, so the read that stands alone still cannot
resolve it, and the read that follows the link is where it pays. The refusal did
not move to another construct in the standalone read; it stayed where it was and
will be gone in the linked one.

### 4t. The entries of a record

`Object.entries(record)` names the entries of a dictionary, and only a loop that
names the two parts of an entry could read it. The compiler's sources also build
a map from a record — `new Map(Object.entries(functions))` — and that was
refused with a message about lists of pairs the value model does not have.
Neither use needs a pair: both walk the record by position, and the lowerings
that already exist do it (`blaze_rt_dict_len` and the key and value reads by
index pass).

So `Object.entries(record)` is read wherever a collection is what asked — a
`for` loop that names the two parts, and the source of a `new Map(...)` — and a
`new Map(...)` built from it walks the record the entries came from rather than
the marker the `Object.entries` left behind. Outside those two asks there is
still nothing to hold an entry in, and the message says so.

A record read through a declaration another module writes has no known entries
in the standalone read, and the loop or the copy now waits for the link instead
of being refused. This took the total from 1501 to 1486.

### 4u. A method on a value the read cannot look inside

The largest slice of the session, and the smallest change. A value whose type is
another module's declaration is carried as an opaque reference until the graph
links it, and the read already waited for the link when the *name* the value was
read through was one of those. It did not wait when the value itself was the
opaque one: `this.frame().block.statements.push(statement)` has no name to check,
and the class lookup refused `push` as a method of nothing.

Now a method written on an opaque value waits for the link the same way, which is
what the opaque reference means: what the value holds is the link's to say. The
read that follows the link holds the declaration and refuses the method there
where there is really none — `importsArePending()` is already false for a linked
read, so the deferral cannot leak into a build. What it changes is the
*measurement*: 1486 to 863, and 15 sources read whole instead of 11.

That is not 623 slices' worth of work: it is one construct — the method written
on a field of a type another file declares — counted 623 times because every
file that touches the IR, the program record or the analysis hits it. The queue
it leaves behind is a much truer one, and it is the queue below.

### 4v. The type arguments of a call

`a.reduce<number>((sum, one) => sum + one, 0)` writes the type arguments of the
call between its name and its arguments, and the reader had no place for them:
the `<` was read as a comparison, so a one-argument method survived as
`a.map < string > (...)` — a comparison of a function with a type name that
happened to be "read" — and a two-argument one was refused as `expected ")"`.

A `<` whose matching `>` is followed by `(` is now read as the type arguments of
the call, and the list is skipped: the types are the source's statement about a
call and the language does not carry them. The scan refuses a list that holds a
number literal, a question mark or an arithmetic operator, because
`shift < 32 ? value << (32 - shift) >> (32 - shift) : value` is the comparison
and the shifts it looks like, and reading it as a type list swallowed the
conditional (which is how the first version of this slice refused a line of
`ir-wasm.ts` that had been read before it).

This took the total from 863 to 862.

### 4w. An arrow that calls itself

`const count = (node: Node): number => { ... count(child) ... }` is how the
sources walk a tree: the compiler's Python skin, its optimiser and its machine
backend all recurse with an arrow. The arrow is read *before* the declaration
binds it, so the call the body writes of the name it is about to be given was a
call of a name nothing had bound, and the declaration refused it with "count
calls itself, which an arrow function is not".

The function is named before its body is read, and the arrow is bound to it for
the length of that read: a call inside the body is rewritten to the lifted
function exactly as every call site after the declaration is. A body that only
*calls* itself is a plain recursive function and needs no closure at all; a body
that hands itself to a collection method reads the signature the declaration
wrote. A body that recurses *and* captures is still refused, because the values
it captures are leading parameters of the lifted function and a call written
before they were known did not pass them.

Three smaller holes under the same reading:

- `children: Node[]` is a field named for the record it is written on. The
  field's type is the *name*, and a name is not the record: it is resolved
  before the literal is read, so the empty list a leaf writes is held at
  `Node[]` and not reported as an empty list with no element type.
- `Object.create(null)` is an empty record with no prototype, which the sources
  write where a dictionary is filled by key. A record here is a dictionary, so
  it is the runtime's empty dictionary.
- A name bound to an arrow is a function the file can call, so
  `list.map(normalise)` reads the arrow the declaration lifted.

This took the total from 862 to 828.

**A finding, not a slice.** `type X = | A | B` — the leading bar the sources
write when the members are laid out one per line — is read as a member that is
`any`, and a union whose first member is `any` is `any`, so *every* such
declaration erases. Fixing it lowers the frontend's own count by 5 and raises
`semantics/python.ts` by 22, because the types it erases are the ones whose
lists are walked with `flatMap` and with callbacks that are not arrows yet. It
is a real bug and it will pay once those methods are read; until then it does
not lower the budget, so it is not in this slice. (It was taken later, once the
report read the linked graph: §4bp.)

### 4y. The entry a dictionary does not hold

`m.get(k)` over a `Map<string, Info>` asks the dictionary whether it holds the
key and reads it where it does. Where it does not, the answer was the *boxed*
number zero — a handle into the runtime's table rather than nothing at all — so
reading a field of an absent entry read the table as an object, and `m.get("zz").name`
segmented the C backend and the machine backend alike. The answer for a key that
is not there is now the zero of the value's own representation: the null
reference for a reference, the empty text for a text, the number zero otherwise.

That is one half of the slice. The other is what a choice is *carried* in: an
unshaped reference is a `double` here, so a choice between one and nothing is a
choice between a `double` and `0.0` — a `double` compared with `NULL` is not C at
all, and the C backend wrote both the choice and the `?.` that tests it that way.
`absenceOf` in `ir-c.ts` is the one place that says what the absence of a type is,
and the choice, the coalesce and the null test all ask it.

With the representation settled, a dictionary read became repeatable: the guard
the chain writes asks `has` and then `get`, and nothing between them writes the
dictionary. So `m.get(k)?.field` is read.

The last piece is the `??` that follows a chain. `o?.a?.b ?? 0` is two guards,
each answering nothing where it finds nothing, and the fallback answers for
*each* of them. A `??` over the choice cannot do that, because the zero of the
guarded value is the zero of its type — an empty text for a text — and a `??`
that tested for absence would hand the empty text back in place of the value the
source named. The frontend now folds the fallback into every absent arm of the
choice, so `m.get(k)?.name ?? "none"` answers `"none"` for a key that is not
there and the empty name for one that is.

This took the total from 828 to 812.

### 4z. A write to the place the source named in full

A write is written to a *place*, and the place was only ever a plain name, a
field of a name, or an element of a name. The sources write
`(loop as { neverExits?: boolean }).neverExits = true`,
`this.results[at] = value` and `holder.items[i] += 1`: a cast, an element of a
field, an element of any value at all. The reader looked at the tokens and gave
up, and what was left was read as an expression, which is `unexpected "="`.

A statement that begins with an expression beginning at depth zero and whose
top-level operator is an assignment is now read as the write it is: the place is
read as an expression, and where it is not a name it is read into a name of the
statement's own first, so the value before the last field is read once — which
is what the source wrote. The write itself is the `memberAssign` or `indexAssign`
the IR already had.

This took the total from 812 to 799. The eight writes left behind it are
`list.length = n`, which truncates a list, and that is a value-model slice of its
own: a list is a block the runtime allocated and its length is the runtime's.

### 4aa. A place stepped by one

The same story for `++` and `--`: `this.tokens[this.position++]` is the element
at the old position, and the position is one more afterwards. Only a name could
be stepped. A place that is a field or an element is now read into a name of the
statement's own, the name is stepped beside the statement, and the value is that
name — so the read of the place and the step are the two things one `x++` does,
and the step still happens where the statement returns.

This took the total from 799 to 785.

**A wrong answer found while testing it.** `a[i] += 1` on the machine backend
wrote the one and not the sum, on both backends' *front end*: the element was
read out of the slot the element's *address* is kept in rather than through the
address, so the old value was the address itself. `readSlotAt` is gone; the
compound write loads the address and reads through it, which is what the plain
write beside it already did.

**A second finding.** Two object literals of the same interface whose list field
holds a different number of values are laid out as two layouts: the field is
typed `array<T,n>` from the length of the literal, so `{ children: [] }` and
`{ children: [a, b] }` cannot be one `Node`. The compiler's own IR nodes are
written exactly that way, so this blocks the self-build — at the object pass,
which the gap report does not measure.

### 4dm. A spread whose value the read does not shape

    { ...built.outcome, refused: `no` }      // the fields the use names
    ...(debug ? { onPrompt: printPrompt } : {})   // a function's zero is null
    ...(names ? { valueShapes: names } : {})      // a map's zero is no dictionary

Two readings of the same shape. A spread of a value whose own shape is not held
— a method of another module, a value the link has not named — copies the fields
the *use* names, which are the fields the object it is written into has. And a
conditional spread needs the zero of the field's type where the function, the
map and the set had none: a function is a closure, so its zero is the null
closure; a map and a set are one handle on the runtime's dictionary, so their
zero is no dictionary at all.

The total went from 236 to 231.

### 4dl. A rest field

    const { statements, ...whatItDoes } = definition

The fields a destructuring pattern does not name are the rest of the record.
The pattern now binds them as a record of their own — an object written out of
the remaining fields, held at the shape they are — so a field of the rest reads
the field the declaration wrote.

The total went from 241 to 236.

### 4dk. A record spread into a record

    { ...objectLayouts }                  // every entry the dictionary holds
    { ...a, extra: 1 }                    // and the entries written beside it

A `Record<string, V>` is a dictionary, and `{ ...a, ...b }` is every entry of
both in the order the source wrote them, a later key writing over an earlier
one. The spread of a dictionary was refused — the fields a literal names are
laid out field by field, and a dictionary has entries it does not name. The
literal is now the parts merged: each field is a dictionary of one entry, each
spread is a dictionary of its own, and a helper copies every part's entries into
one dictionary in order, reading and writing each entry by what it holds. A
member read on a dictionary — `both.size`, `both.extra` — is the entry that key
names, and `Object.keys` is the entries it holds.

The total went from 246 to 241.

### 4dj. A map that answers a list

    [1, 2].map((x) => [x, x + 1])      // a list of the lists it answered

An element of a list may itself be a list — `string[][]` is a value the sources
hold — so a `map` whose callback answers a list is the list of the lists it
answered. The read refused every list answer because a typed array was the only
element a map was thought to build; an element here may be a list, and the block
a map builds is a block of them. A pointer or a mask is still not an element,
and a callback that answers nothing is `forEach`.

The total went from 251 to 246.

### 4dp. A spread of a call, and a method of a class another module declares

    { kind: `while`, ...this.loopInfo(body) }      // the record the call answered
    { ...failure.toJSON(), project: id }           // a method of an imported class

A spread copies the fields of the record its value names, and the record a call
answers is not known until the callee's body has been walked: `Info` is a shape
the object pass builds, and the function that answers one names it only after
its body has been read. The layout pass now walks every body again with the
answers the round before settled, and stops when no answer changed. A call's
answer is then the layout its callee builds, so a field copied out of it is the
field's type and not the opaque reference.

A field read through a value held at a layout's name — `ref<ObjectN>`, which is
how a function's answer is spelled once the pass has named it — is that
layout's field; the type table names no such declaration, so the layout pass is
what says it.

A method of a class another module declares answers a type the declaring module
wrote, and the file that calls the method may not import that name. The shape is
resolved where the method is declared and crosses the link with the class, so
`failure.toJSON()` answers the record `Serialized` and `{ ...failure.toJSON() }`
copies its fields. A spread of a value the link has not named yet is deferred
rather than refused, as every other pending value is.

A spread whose value is a call is read into a name of the statement's own, so
the call runs once and every copied field reads that one answer.

The total went from 220 to 213.

### 4dq. A truth a literal writes is a truth the field holds

    { region: false }        // the field is a truth, and prints `false`

`true` and `false` are held as the numbers one and zero, and a literal written
into a field was typed as the double that number is: the field the source wrote
a truth into was laid out as a double, and the text it printed was `0` rather
than `false`. The literal keeps the truth the source wrote, marked on the
literal itself, so the layout pass, the type of an unannotated default and the
inference of a return all read it as a truth. No refusal changed; the IR a field
of a record is built as did.

### 4dv. An arrow the use holds at a function type

    const reader: ModuleReader = read ?? ((source, path) => ({ ... }))

A type alias written as a function type states what an arrow answers, and the
arrow was read with no result type: an empty list it writes in its result object
was a list no use had said the element type of. The arrow now takes its result
type and shape from the function type the use expects, so the fields it writes
are read at the record the alias names.

The total went from 204 to 203.

### 4dw. A record rebuilt from the entries of a record

    Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([name, v]) => [name, f(v)]))
    Object.fromEntries(files.flatMap((file) => Object.entries(file.functions)))

An entry of an object is read by position in a loop and in a map, and a
callback that takes the pair names the two values at once: a mapping over the
entries of a record is the loop of the record's own entries. That loop now
lowers through the pair machinery — the callback is read under the loop flags,
so the entries are marked rather than refused, and a destructured pair's names
are read as the pair parts they bind. Where the loop walks the entries of a
dictionary, the two parts are the key and the value the dictionary reports at
that position. A flat map whose callback answers the entries of each element's
record concatenates those entries, in element order, into the record the call
answers: each element's dictionary is read and its entries copied in turn.

    The total went from 203 to 200.

### 4gl. `JSON.stringify` writes a record at the indent the source names

    JSON.stringify({ ...contract, definition: whatItDoes }, null, 2)

The indent a third argument names was refused: the compact text the parser built
was the only writing it had. A value the read can name is now written at the
indent field by field — a record by its fields in the order they are written, a
list by a helper that walks it, a dictionary by its entries, a truth as the word
the language writes, and a text or a number through the runtime's own writing of
one value. A nested record is the same walk one level in. `ai/review.ts` reads
whole; `core/json-store.ts`'s `JSON.stringify(value, null, 2)` is still refused,
because `value` is a type parameter the read cannot name and a compiled record
is not a dynamic handle the runtime can walk.

    The total went from 63 to 62.

### 4gk. `Object.assign` widens the object a declaration wrote

    const withTypes = types.length === 0 ? {} : { types };
    if (renames.length > 0) Object.assign(withTypes, { renames });

The language lets an object grow a field, and the read of a record field is a
layout: `renames` was a field neither arm of the choice wrote, so the assignment
was refused. The object the declaration wrote is now widened with the fields the
assignment adds — a choice of two literals is widened in both arms, and each arm
writes the zero of the field the other leaves out, so the choice is one layout.
A target whose value this body did not write is still refused. `semantics/repair.ts`
already read whole; `semantics/typescript.ts` reads one refusal shorter.

    The total went from 64 to 63.

### 4gj. The entries of a map are a list of pairs a callback walks

    const ordered = [...counters.entries()]
      .filter(([name]) => !shared.has(name) && ...)
      .sort((left, right) => right[1].depth - left[1].depth);

`[...map.entries()]` was only a loop head: outside one, `entries` was a method
of nothing, and `Object.entries(record)` was read only where a loop names the
two values. A map's entries are now a list of pair records — `first` the key and
`second` the value — where the pair is an object because a key and a value of
two kinds are not one element type. A destructuring callback binds the pair's
fields in the order it writes them, a map spread of two different kinds is the
same list, and `new Map(pairs)` writes the pair records back into a dictionary.
`Object.entries` as a value is the list too, so a `flatMap`/`filter`/`map` chain
over it reads.

A field that holds a text is laid out as the text it is, where a call's answer
used to lay out as the unshaped reference: the pair's key read is a text, and a
comparison of it with a text is a comparison of two texts.

`toolchain/ir-machine.ts` and `semantics/typescript.ts`'s entry reader read
whole, and `incremental.ts` reads one refusal shorter.

    The total went from 69 to 64.

### 4gi. A template interpolation reads the shapes its imports bind

    const services = ${JSON.stringify(HOST_SERVICES.map((service) => service.symbol))};

A template string is read by a parser of the same file, and that child parser
was handed the file's tables but not the shapes its imports bind. `HOST_SERVICES`
is a list another module declares, so inside the interpolation it was a value
with no type and `.map` was a method of nothing. The child now carries the shapes
the file's imports bind, as it already carried the rest of the file's tables.
`toolchain/wasm.ts` reads two refusals shorter.

    The total went from 71 to 69.

### 4gh. A method of an object type inside a field is the function the call reads

    interface Engine {
      Module: {
        exports(module: unknown): { name: string }[];
      };
    }

A method written in an *inline* object type was dropped: the reader that reads
`A: { ... }` handled `name: type` and skipped `name(params): type`, where the
interface reader beside it kept methods as function-typed fields. `engine.Module.exports`
was a field of an empty record, and the `map` after the call was a method of
nothing. An inline member whose name is followed by `(` is now the function type
its parameters and result write, so the call is the call of the function the
field holds. `toolchain/wasm.ts` reads four refusals shorter, and the one left
is the engine module it constructs, which is a host boundary.

    The total went from 75 to 71.

### 4gg. A generic function that answers its parameter's type hands the argument back

    function substituteShallow<T>(node: T, scope: Scope): T { ... }
    const rewritten = substituteShallow(statement, scope);
    Object.assign(statement, rewritten);

A compiled function cannot spell a type parameter, so the answer of an identity
`T` erased to `any`: `rewritten` had no shape, and the record `Object.assign`
copies was a before-and-after value it could not name. The scan now keeps a
generic function's type-parameter names, its result annotation where it is one
name, and each parameter's annotation the same way. A call whose answer is one of
those names is read at the argument written at that parameter, which is the value
the function hands back. `semantics/repair.ts` reads whole.

    The total went from 76 to 75.

### 4gf. A compiled object knows the names its layout wrote

    const n = node as Record<string, unknown>;
    if ("value" in n && typeof n.value === "object" && n.value !== null && "k" in n.value) { ... }
    if (n.k === "call" && "args" in n.call) { ... }

`value as Record<string, unknown>` on an `unknown` named a dictionary the value
never was: `"value" in n` was the dictionary's `has` on a compiled object
pointer, and the answer was always no. The runtime header now carries the field
names the layout wrote, NUL separated and ending in an empty name, and every
object is described with them where it is allocated. `"key" in n` is a question
the runtime answers from the object itself, and the assertion is read as the
object view it is rather than as a dictionary.

The header grew to sixty-four bytes, the alignment its payloads are placed at
needs it to be a multiple of sixteen, and the C runtime, the Nim adapter and the
WebAssembly host carry the same word. The C and machine backends and the
WebAssembly module write the descriptor beside each object they build.

`toolchain/program-emit.ts` and the `in` in `semantics/repair.ts` read. The
resolver's other refusals in those files are the JSON indent and a shared counter.

    The total went from 83 to 76.

### 4ge. A file the compiler opens is the compiler's own handle

    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }

`open` was re-exported from the host, so the handle it answered was a host type
the read could not see, and `sync` and `close` were methods of nothing. The
platform layer now declares the handle the compiler holds, with those two
methods, and opens a file as that handle; the host's own handle is what is
behind it. `core/json-store.ts` reads two refusals shorter (the file still has
the JSON indent and the shared counter).

    The total went from 85 to 83.

### 4gd. A callback annotated `any` takes the element the method hands it

    const candidate = Object.values(this.objects).find((item: any) =>
      item.fields.length === expandedFields(value).length &&
      item.fields.every((entry: any) => fieldNames.has(entry.name)),
    );

The callback writes `any` to say it does not care what the value is, and the
read obeyed: `item` was the unshaped reference, and `item.fields` was a field of
nothing, so `every` was a method of nothing. The method the callback is handed
to knows the element — a list of layouts has a layout at every position — and a
record erases to the unshaped reference, so the shape the method knows is what
the callback's parameter is given. `semantics/ir-resolve.ts` reads whole.

    The total went from 86 to 85.

### 4gc. A map value read through a fallback keeps its fields

    const declared = this.functions.table.get(`${value.function}__${value.args.length}`) ??
      this.functions.table.get(value.function);
    const captured = declared.captured.map((capture, position) => { ... });

`Map.get(k) ?? Map.get(j)` is one entry of the map: the absent arm of the first
read is answered by the second, and the `??` is folded into the choice the first
read already was. The folded choice was a new value, and the shape the map's
value holds was not carried to it, so `declared` was `any` and `captured` was a
field of nothing. The fold now copies the type and the shape of the choice it
replaces.

    The total went from 87 to 86.

### 4gb. An intersection with a tag narrows a union to its arms

    private buffer(value: DraftValue & { k: "buffer" | "sized" | "view" }, line: number): SemanticValue {
      const held = value.held;
      ...
      values: held.values.map((item) => this.value(item, element, line)),

The type is a union narrowed to the three kinds of block, and the read kept the
whole union: `value.held` was the first arm's `held` — a number, not the array
the three arms hold — so `held.values` was a field of nothing. The intersection
of a union with a tag now keeps the arms whose field writes a literal the tag
names, and the tag may name several (`"buffer" | "sized" | "view"`). A field
those arms share is read through them, and the resolver's `buffer` reads whole.

    The total went from 88 to 87.

### 4ga. A callback declared below the arrow that uses it

    const walk = (items: string[]): void => { items.forEach(value); };
    const value = (one: string): void => { console.log(one); };
    walk(list);

A block's declarations are read before its statements, but an arrow a
declaration is initialised with was not: `walk` was read first and `value` had
no signature, so `items.forEach(value)` was refused. The arrow's parameter and
result annotations are now read in the prescan, and an arrow a body written
above it takes as a value is declared as the closure that body is handed.
`walk(list)` passes it, and both backends print what the source prints.

    The total went from 90 to 88.

### 4fz. A union narrows by its tag field

    const inner = part.value;
    if (inner.k === "text" && inner.parts.every((one) => one.k === "text")) { ... }

A union of records is one record with the fields of every arm and the arms beside
them, and a field only one arm writes is read through the union as the first
arm's type. `inner.k === "text"` was a comparison and nothing more: `inner`
stayed the union, so `inner.parts` was a field of the merged record and `every`
was a method of nothing. The literal a field is declared as is now kept with the
field, and a test on it settles the value at the arm that writes that literal —
and, where the test fails, at the arms it does not name. A `switch` over a tag
settles each case the same way when the case is reached only by its own match.

`semantics/optimize-ir.ts` reads whole.

    The total went from 91 to 90.

### 4fy. A map spread into a list is its entries

    if ([...remapped].some(([key, root]) => key !== root)) { ... }

    const all = [...bodies];   // bodies: Iterable<SemanticFunction>

`[...map]` was the map handle, not the entries the source wrote, so the method
after it was a method of nothing. The spread is now a list of the map's entries
when key and value are the same kind: the pair is a list of two of them, built
by the append loop, and the callback destructures it. A name assigned the answer
of a function holds the collection that function's return type names, which is
what `remapped = uniteShapes(shapes)` needed.

`[...bodies]` over `Iterable<T>` (and `ArrayLike<T>`) is the list of T: a list is
the only thing the subset walks, and the type names what a loop or a spread over
it holds.

`semantics/objects.ts` reads whole.

    The total went from 94 to 91.

### 4fx. An empty list in a call argument takes the type the call says

    this.scopes.push({ id: block.id, names: ..., allocated: known === undefined ? [] : null });

    return this.closed({ k: "buffer", ..., values: [] });

Two calls in the compiler's own sources write an empty list inside a record
argument. The first was read at the parameter of an unrelated class's `push`: a
method name only one class answers was used as the call's type even though the
receiver is a list, so `allocated: []` had no element type. A sequence receiver
now answers the method itself, and the element the list holds gives the record
its fields.

The second was `closed<T>(value: T): T`, an identity whose type parameter
erases to `any`: the argument had no type, and the `values: []` inside it had
none either. A method that answers the type of its only parameter now reads that
argument at the type the call itself is read at, which the enclosing `return`
states. `toolchain/ir-wasm.ts` and `semantics/ir-text.ts` read whole.

    The total went from 97 to 94.

### 4fw. The path namespace the compiler reads its own imports through

    return posix.normalize(posix.join(posix.dirname(from), candidate));

The module graph resolves an import against the file it names, and it does that
path work through the POSIX namespace: the directory of the importing file, the
candidate joined to it, and the `..` parts resolved. A call of `posix.dirname`
was a method of a value the read could not type, so `semantics/module-graph.ts`
was refused over it. The namespace is now read as the runtime's path work —
`posix.dirname`, `posix.join` and `posix.normalize` — and the runtime answers
the POSIX write of each: the directory part (a double root keeps both
separators, and a run of trailing separators names no part), the path joined and
normalized, and a trailing separator kept where the source wrote one. The C
runtime, the Nim adapter and the WebAssembly host answer the same text, and the
C runtime's answers are compared to the host's own `path.posix` for the
boundaries.

`semantics/module-graph.ts` reads whole.

    The total went from 98 to 97.

### 4fv. A block the file allocates at the top is typed by its constructor

    const FLOAT_BYTES = new DataView(new ArrayBuffer(8));

    FLOAT_BYTES.setFloat64(0, value, true);
    for (let at = 0; at < size; at += 1) bytes.push(FLOAT_BYTES.getUint8(at));

A top-level `const` whose value is constructed is state: the file holds one
block, so the declaration is not inlined at each read. What the *name* holds was
then not written down, and a method on it was a method of nothing — the three
view reads and writes `toolchain/ir-wasm.ts` writes over its float bytes. The
scan now records the element the constructor allocates (a typed array's own
element, a byte for `ArrayBuffer` and `DataView`), and a function body is seeded
with those names at the type of the block. The DataView methods are read; the
file still refuses an empty array in a generic call.

    The total went from 101 to 98.

### 4fu. A splice writes the field a chain of fields names

    target.owner.statements.splice(at, 0, ...hoisted);

A `splice` on a name or on a field of a name was the list written back where it
was; a field of a field had no writable place, so the call was refused as a
method of nothing. The chain's base is now read once into a name of the
statement's own — a record is a reference, so writing the field through that
name lands in the same object — and the list is read through that same name.

The second half of the slice was not the frontend. The optimizer inlined the
splice's answer into its one use, past the write, so the answer became the slice
of the list *after* the splice: `splice(1, 1)` answered `3` where the source
says `2`. `inlineSingleUses` moves a value to its read only when nothing writes
the names it reads in between, and a field write was not one of the writes it
knew. A `storeField` on an object now counts as a write of that object, so the
answer stays where it was computed. `semantics/repair.ts` reads one refusal
shorter.

    The total went from 102 to 101.

### 4ft. A union asks the kind of the value it holds

    const extra = (this.program.extraFunctions ?? []).map((extraFn) =>
      typeof extraFn.body === "string"
        ? extraFn.body.split("\n")
        : this.function(extraFn.body as SemanticFunction),
    );

`typeof extraFn.body` over a field typed `string | SemanticFunction` was
answered from the type, and a union of shapes is not one kind: the read called
it an object, so the arm that splits a text compiled nothing and the `.split`
was refused as a method of nothing. A record of fields is one kind and still
answers from its type; a union is the question the runtime's `JSON.typeof`
answers, and the branch it holds in reads the field as the text it is.
`toolchain/program-emit.ts` reads one refusal shorter.

    The total went from 103 to 102.

### 4fs. A number written at its significant digits

    return Number.isInteger(value) ? value.toString() : value.toPrecision(17);

`toPrecision(p)` is the number written at `p` significant digits: in full while
the decimal exponent is from -6 up to `p - 1`, and in exponential form outside
that range, with a tie written away from zero. The frontend read `toFixed` and
`toString`; the third writing a number at a count of digits was a method of
nothing, so `semantics/frontend.ts` — whose f32 literal is written at seventeen
digits — was the one source the linked read refused over it.

The count is a literal in the source, as `toFixed`'s is. The lowered value
carries it beside the number, and the machine, C and WebAssembly backends all
ask the runtime for `blaze_rt_format_number_precision`, which is the twin of the
fixed form: the digits are the library's scientific writing, scaled by the
exponent, and a tie the library breaks to even is corrected on the exact value.
A program body's driver writes it through the same runtime, and the IR text
spells it `to_text@p17`.

`semantics/frontend.ts` reads whole.

    The total went from 104 to 103.

### 4fq. The JSON of a list a program builds, and the tuple type a pair is

    const fields: (readonly [string, string])[] = [];
    fields.push([field.name, describe(field.value.inferred)]);
    const key = JSON.stringify(fields);

A list written where it was read was already written as JSON; a list built while
the program runs was refused, because a compiled list is a block of one element
type and the text of its JSON is not a text the parser can build in place. The
helper the compiler now writes walks the block once per element type: the
brackets, a comma between the elements, and each element's own JSON — a text or
a number is the runtime's stringify of the value it is, and a list is the helper
again for what the inner list holds. An element that is an object is still
refused: a compiled object holds no field names at run time, so its JSON is not
a text this compiler can write. `semantics/ir-function.ts` and
`semantics/program-objects.ts` read whole, and `semantics/objects.ts` is one
refusal away.

The other half is the annotation those three files write a pair as: a tuple,
`(readonly [string, string])[]`. The type reader read a tuple — and a
parenthesized type — as the opaque reference, so the list's elements were
boxed as dynamic handles and the helper's block was a block of doubles. `[A, B]`
is now the list of the values it names, which is the one layout a compiled list
has, and what the three files declare is what they build.

    The total went from 112 to 108.

### 4fr. Promise.allSettled reports how each promise settled

    const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
    const failure = settled.find((entry) => entry.status === "rejected");

`Promise.all` was already read as the list of the values each promise carries;
the settle-each variant the build pools use was a method of nothing. It is the
same walk with one extra question per promise: `Promise.allSettled` answers a
list holding `{ status, value, reason }` for every promise, `"fulfilled"` with
what it carried or `"rejected"` with the message it failed with. The helper
that builds it is generated once per program and reads `Promise.failed` and
`Promise.message`, the builtins a chained promise already asks.

What it needed was the value a call answers to be the handle it is. A call of
an `async` function was typed at the payload its declaration states, so
`Array.from({ length: n }, () => worker())` was an empty list of nothing and its
elements were promises that had never been made. The declaration's payload is
what `await` reads out of the handle, so a call of an async function is now the
reference a promise is. An await of a name a continuation held carries the
shape that name was given, beside the type. `compiler.ts` and `codegen.ts` read
whole.

    The total went from 108 to 104.

### 4fp. A promise a body chains

    const present = await stat(cached).then(
      (entry) => entry.isFile() && entry.size > 0,
      () => false,
    );
    await rm(path, { force: true }).catch(() => undefined);
    core.catch(() => undefined);

A promise could be made, awaited and settled, and the three methods a body
chains it with were methods of nothing: `then`, `catch` and `finally`. A
compiled promise is settled by the time it is read — the executor runs where
the promise is made — so the continuation is the conditional it means. `then`
asks `Promise.failed`, hands the message to the rejected arm and the value the
promise carries to the fulfilled arm; `catch` is the rejected arm alone and
answers the value otherwise; `finally` runs its callback for what it does and
answers the promise. The value an arm is handed is what the promise's
declaration says it carries: `Promise<FileInfo>` is an entry in the callback,
and `entry.isFile()` is the field the entry declares.

The runtime already had `blaze_promise_failed` and `blaze_promise_message`,
declared with the rest of the ABI; they are `Promise.failed` and
`Promise.message` in the builtin table now, lowered by the C, machine and
driver targets. Reading the message is what *handles* the failure: the pending
error flag is what an async function's own promise settles on, so the builtin
clears it, exactly as the arm of a `catch` block does. Without that, a failure
one arm took leaked into the promise the enclosing async function answered, and
a later `then` never ran — the test that reads a chain printed nothing.

The continuation is written as an `if` over a name of the statement's own
rather than as a choice of two values. An arm is a value in this IR, and a call
that answers nothing is not one: the rejected arm is a call of the callback and
a read of the message, and the arm that does not run must not clear the error.

Three backend defects surfaced with it. A `void` value read at another type had
its call dropped by the C conversion, so an arm that only ran for what it did
compiled to nothing; a `set` of a name nothing reads kept the declaration alive
only for compound operators, and a plain `set` in an arm lost it, which the
validator refused by name. Both are fixed where they were.

`runtime/facil.ts` and `runtime/standalone.ts` read whole now, and
`compiler.ts` is down to three refusals. What is left of the promise surface is
`Promise.allSettled`, whose records a list holds only once the value a promise
carries is a record of its own (see §3), and `new Promise`, refused with the
other allocations a function body writes.

    The total went from 123 to 112.

### 4fo. A class built on another, and the absence a choice of texts answers

    class BlockReader { protected readonly lines: IrLine[]; constructor(lines, binder) { … } }
    class ProgramReader extends BlockReader { … }

`semantics/ir-text.ts` reads a body with one reader and a program with another,
and the two are a base and a subclass: every method of the base is a method of
the two, and neither subclass writes a constructor. Inheritance was refused by
name, so the file was two refusals away from whole.

A class extends another in the same module now. The derived class is built by
the nearest base's constructor — `new ProgramReader(lines, binder)` passes the
arguments through, as the language does for a derived class with no constructor
— and its object is one layout with the base's fields first and its own after,
so a method written on the base reads the same field of the same object when it
is called on the derived instance. A base another module declares is still
refused, because the body of its constructor is not in this file's tokens.

The test that reads a derived class hung the candidate instead of answering:
`for (;;) { const line = this.peek(); if (line === null) break; … }` never
broke. `peek` answers `this.at < this.lines.length ? this.lines[this.at] : null`,
and the two backends disagreed about what the absent arm of a choice of texts
is. The C backend wrote the empty text where `absenceOf` says the null pointer,
so the `line === null` after it was false, the empty text was added to the sum,
and the loop read the same absence again for every turn. The machine backend
wrote the absence in the representation of the arm's own type — an unshaped
reference, which is a `double` — leaving a float in `xmm0` where the text in
`rax` was asked about. The C backend now answers `absenceOf` for the choice, and
the machine reads an absent value at the type the use reads it at.

    The total went from 124 to 123.

### 4fn. The host's directory entry, and a path, as the compiler's own types

    const entries = await readdir(dir, { withFileTypes: true });
    if (entry.isDirectory()) walk(entry.name);
    found.set(relative(root, path).split(sep).join("/"), text);

`readdir` and `stat` were re-exported from the host, so the compiler's own
sources were written against the host's type: `entry.isDirectory()` was a
method of nothing, because the declaration of the entry was a Node module the
tree does not hold. The boundary's whole point is that the source asks its own
platform for the data it needs, so `core/platform.ts` now states the two shapes
the compiler reads — `DirectoryEntry`, which is a name and the two questions
"is this a file" and "is this a directory", and `FileInfo`, which is a size and
the same two questions — and the adapter answers them. `readdirEntries` is the
operation the compiler actually asks for, and `stat` keeps its name with the
compiler's answer type.

The pure path work was the host's for the same reason: `relative(root, path)`
was a call of a name the linked read knew nothing about, so the `split` written
after it was a method of nothing. `dirname`, `extname`, `isAbsolute`,
`normalize` and `relative` are now the compiler's functions answering `text`,
declared in the adapter with the host's implementation behind them. `join` and
`resolve` take any number of parts and stay the host's until the rest parameter
of a call is read against a declaration on the other side of the link.

`core/version.ts` and `core/json-store.ts` lose the refusals this named, and
`core/version.ts` reads whole. Two places remain that name a host value: a
`catch` on a promise (`readdir(...).catch(() => [])`, `compiler.ts`) and the
entries a host value answers where no platform function declared the type.

    The total went from 131 to 124.

### 4fm. A call of what a call answered, and the callee of an indirect call

    createCommandCode({ apiKey, baseUrl })(configuration.model)
    make()(model)
    ops[0](5)

A call was made through a name or a field, and a value a call answered was not
one of them: `createX(...)(model)` was `only a named function is called`. The
answer is a value of a function type — a declaration that returns an arrow
(`createCommandCode`), a parameter typed at a function that returns one
(`make: () => ((x: string) => string)`), a field of the record a call answered,
or an element of a list of functions — and the call is the same indirect call a
function-typed field already made. The callee's type states the parameters and
the result, so the arguments are read at those and the value is an `invoke`.

The shape of the answer is kept beside the `invoke` a name held at a function
type makes, so `make()(x)` reads what `make` was declared to answer rather than
the `any` the contract erases a function type to. The list element is read the
same way: `ops[0](5)` is an invoke of the element the list's declaration types.

That last form found a bug the read had hidden. An indirect call states its
callee in `SemanticCall.through`, and no walk over an IR value visited that
field: `valueChildren` answered a call's arguments alone. `dropUnread` then
counted no read of the name holding the list, dropped its `let`, and the C
backend emitted a call through a name the function never declared. The callee
is a child now, in `valueChildren` and `withChildren`, and the liveness pass
reads it before the arguments and again where the call is made, as it does an
argument a callee is handed.

The four calls of the package providers in `ai/backend.ts` are still refused:
`createOpenAI` and its siblings are imported from packages the tree does not
hold, so the frontend knows no type for what they answer. They are the
transport §5 replaces, not a construct the language is missing.

    The total went from 132 to 131.

### 4fl. A list joined with a value, and a loop that awaits

    .filter((line) => line.length > 0)
    .concat(`${sourceDir}${tlsBackend}`);
    for await (const entry of await readdir(dir, { withFileTypes: true })) { … }

`concat` was the lists written one after another, so an argument that was not a
list was refused. The language accepts one: the value becomes the last element,
which is the list joined with a one-element list of it, at the element the answer
holds. A value of another type is still refused.

`for await (const x of …)` had no reading at all: the loop reader saw `await`
where the `(` was expected. A compiled program runs straight through and the
source writes the `await` on the iterable where the iterable is a call, so the
loop is the for-of it is. An iterable that is itself a promise is refused by the
for-of reader, which walks a list.

`runtime/facil.ts` is down to the `isDirectory` and `catch` refusals.

    The total went from 133 to 132.

### 4fk. A whole number written in base two

    const bits = base === 0n ? 1 : base.toString(2).replace("-", "").length;

`toString` answered base sixteen and nothing else, so a number written in base
two — `base.toString(2)` in the compiler's own wide arithmetic — was refused
where the radix was read.

The digit count a `fixed` carries already marks a radix (`-1` is sixteen); `-2`
is two. The runtime formatter, which took a base but answered only ten and
sixteen, now divides by any radix from two to sixteen, with sixteen keeping the
limb-by-limb nibble loop it had. The machine backend hands the formatter the
radix the value carries, the C program driver widened it into the same
formatter, and the IR text spells it `@bin` beside `@hex`.

The reading test pins both forms — a function body and a program body — and the
execution test builds a `u256` written in base two and sixteen with the C and
machine backends and compares it with node. The C backend's function-body
`toText` no longer refuses a radix for a whole number of four limbs: it widens
the value into a `blaze_u256`/`blaze_i256`, formats it into a stack buffer with
the radix, and copies the text into the managed heap before answering it. The
wasm backend's wide branch still prints rather than returning text with a radix,
which is the one half of this construct still missing.

`semantics/whole-arithmetic.ts` is read whole.

    The total went from 134 to 133.

### 4fj. A pattern names the elements of a value

    const [command, argument] = parsed.positionals;

A program declared one name per statement, so a pattern — the names of a value
rather than the value itself — was refused where the declaration reader expected
a name. Each name of the pattern is one element of the value: the value is read
once into a name of the statement's own, and every name is the element at its
position, so a call in the value runs once and the names are the parts node
would bind.

The statements are the scope's own and not a block's: the declarations are
queued beside the statement the reader answers with and every reader of
statements drains the queue first, because a name declared inside a block a
program never wrote would not be the name the next statement reads.

A rest element — `...rest`, the list from that position on — is a slice of the
value, and a program has no value for a slice of a list, so it is refused with
its own message and `cli.ts` keeps that one refusal.

    The total went from 135 to 134.

### 4fi. A program asks the kind of a value with `typeof`

    if (!this.at(")")) return this.value();
    if (typeof values.from === "string") ...

A program had no `typeof` at all: the word is an identifier to the expression
reader, so `typeof values.from` left `values` where a `)` was expected and the
record spread it sat in was refused.

A value written out has a kind the syntax states — `1` a number, `1n` a bigint, a
text a string, `true` a boolean, `null` an object — so the answer is the text
itself and the emitter writes no call. A value the program computes is asked at
run time, through the `JSON.typeof` the module frontend already lowers and the
three backends already carry; a field of a record another module built is a
dynamic handle there, which is what the runtime's tag lookup reads.

The program-body test pins both halves: `typeof 1` is the text "number" in the
body the frontend read, and a program that prints `typeof` of a number, a signed
number, a text, a boolean and a bigint prints what node prints.

Fixing the Nim runtime along the way: `blaze_rt_view_load_float` and
`blaze_rt_view_store_float` named their first parameter `block`, which is a Nim
keyword, so `blaze_rt.nim` did not compile at all and every Nim-driver test
failed at the host link. The parameter is `bytes` now, and the driver tests that
were failing pass.

    The total went from 136 to 135.

### 4fh. A copy made by `structuredClone` is the value it copies

    const clone = structuredClone(fusion.callee);
    clone.calls = [];

`structuredClone` is the language's deep copy: the value it answers holds the
fields its argument holds, at the types the argument wrote them. The frontend
left the call untyped, so the copy was a value of unknown shape — `clone.calls`
was a field of nothing, and the empty list written into it had no element type.
The value was refused where it was written rather than where it was copied.

A call to `structuredClone` is now the type and the shape of its argument,
unless the file declares a function of that name, which the declaration tables
answer first. `semantics/restructure.ts` is read whole and the map over the
spliced block in `semantics/repair.ts` is a map over `SemanticStatement[]`.

The runtime still has no deep copy of its own: this slice is the reader's half
of the construct, and a program that calls `structuredClone` does not link
until the clone a layout would write is added to the runtime.

    The total went from 138 to 136.

### 4fg. A name holding a choice of two regular expressions is a regex

    const whole = minimum === 0 ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
    if (!whole.test(value)) ...

A regular expression is two texts — the pattern and the flags — and a literal is
a block holding them. A name was a regular expression only when its initializer
was a literal, so a name holding a choice between two literals was a plain list,
and `whole.test(value)` had no receiver that answers `test`.

Both arms of the choice are regular expressions, so whichever arm runs the name
holds `[pattern, flags]`: the two parts are the name's two elements, and the
existing lowering — `blaze_rt_regex_test(whole[0], whole[1], text)` — is already
the right call. The declaration now records a name as a regular expression when
its initializer is a literal, a name already known to hold one, or a choice
between two of them.

    The total stayed at 138. This file's count did not fall because the program
    parser already counted the same function's body under a different message:
    `optionNumber` is read as a module function now, so what is left of `cli.ts`
    is the program grammar's own gaps.

### 4ff. A length written through a field of a field

    this.diagnostics.entries.length = saved.diagnostics

`a.length = n` is the list as its first `n` elements, and the list is a value:
the write is the list at that length, written back into the place that holds it.
The place was the name itself or the field of a name, so a list held one field
deeper had no place to write back to and the statement fell through to the
expression reader, which is where the `=` became an unexpected token.

A list held two fields deep writes back the same way the shorter forms do: the
value before the last field — `this.diagnostics` — is read once into a name of
the statement's own, and the write goes into that name's `entries` field. An
object is a reference, so writing the field of the object the name holds is
writing the field the source named, which is the rule a write through a chain of
fields already followed. The test says the IR carries the `memberAssign` into
`entries`, and the program the two backends deliver prints the truncated list
node prints.

    The total went from 139 to 138.

### 4fe. A record keyed by the numbers a source computed

    const size: Record<number, number> = { [SECTIONS.empty]: 0, [SECTIONS.text]: n }

A field written as `[key]: value` was refused as a field that is not named: a
record's fields are names, and the dictionary a `Record` is was keyed by the
spelling of every field. A key the source computed is an expression the
dictionary is built with, and a record whose every key is a number is the
dictionary keyed by numbers — the entries `size[n]` reads. A name the source
wrote keys the dictionary by text, which is the record of fields it looks like.

    The total went from 141 to 139.

### 4fd. `Buffer.from` reads a text as bytes, and latin1 writes them back

    Buffer.from(text, "utf8")
    Buffer.from(bytes).toString("latin1")

`Buffer.from(text, "utf8")` is the bytes the text is written as, which is what
the encoder already answers, and `Buffer.from(bytes)` is a copy of the bytes it
is handed. `toString("latin1")` is the text one byte per character is: each byte
is the code point of the character, written as the utf8 text a compiled text
holds it as, which is a function of the file and needs no new service.

    The total went from 143 to 141.

### 4fc. A buffer read as floats, and a spread written at the list's element

    new DataView(new ArrayBuffer(8))          // a block of bytes and a view of it
    view.setFloat64(0, value, true)           // the eight bytes the number is
    view.getFloat64(0, true)
    [...new TextEncoder().encode(text), 0]    // the bytes, in a list of numbers

`new ArrayBuffer(n)` was refused as no typed array, and a DataView's float reads
and writes as no methods: the bytes of a number are not a sum of them, and the
one place that copies four bytes into an f32 or eight into an f64 is the C
library. Two runtime entries now do that copy — `blaze_rt_view_load_float` and
`blaze_rt_view_store_float` — and a buffer is a block of bytes, so `bytes.buffer`
is the block the typed array is and the view of it is the same bytes.
`body.buffer` on a typed array was a field of nothing before.

A spread whose elements are not the ones the list holds was joined into the list
as it stood, which put a block of bytes where a block of doubles belongs: the C
target read the bytes as eight-byte elements and a program that spread a byte
array into a list of numbers answered a pointer's digits. The elements are now
written as the list holds them, which is the element-by-element copy the typed
array's own `from` writes — a bug the widths of the two blocks made.

    The total went from 148 to 143.

### 4fb. A text encoder writes the bytes a text is written as

    new TextEncoder().encode(text)

The decoder was read and the encoder was not. `new TextEncoder()` is no value of
its own, exactly as the decoder is none, and `encode` is the bytes the text is
written as: the runtime copies them into a block of its own whose length is the
count of them. The one encoding a compiled text is written in is utf8, so the
two halves of it are one runtime entry each.

    The total went from 152 to 148.

### 4fa. The collection bindings a body writes are the body's own

    function declaring(scope: Scope, slot: Slot): Scope { const slots = new Map(scope.slots); ... }
    function innerScope(scope: Scope, slots: Slot[]): Scope { for (const slot of slots) ... }

A module function starts from the collections the *file* holds, which is what
lets a function read a map the file declares at the top. What the previous
function bound was carried in as well, because nothing put the file's bindings
back when a body was answered: `declaring`'s `const slots = new Map(...)` made
`innerScope`'s `slots` parameter a map, and the loop over the list of slots was
refused as a loop over entries. The file's own bindings are put back when a
function is answered.

    The total went from 153 to 152.

### 4ez. A statement that begins with a bracket is the expression it writes

    [...source.values()].forEach((value, index) => { total += value + index; })
    [1, 2, 3].join("-")

A statement that begins with `[` was read as a tuple assignment, because that is
the one shape a bracket can begin a statement with: the pattern was read first
and the `=` came after it. `[...text].forEach(f)` and `[1, 2, 3].join()` are
expressions, and the spread inside the first of them was refused as a
destructured element that binds no name. The bracket begins a pattern only where
an `=` follows its own end, and the statements that are not one are the
expressions they write.

    The total went from 154 to 153.

### 4ey. A push on the list an indexed field holds

    this.scopes[this.scopes.length - 1].push({ name, emitted, type })

A push on the list an element holds — `positions[i].push(x)` — was read when the
block the index reads was a name, and refused when it was a field of an object.
The object is now read once into a name of the statement's own, and the list is
grown and written back at that index, which is the block the field holds: the
push reaches the field the same way a push on a name reaches it.

    The total went from 155 to 154.

### 4ex. A choice of two text reads is a text

    (a.trim() || b.trim()).split("x")

`a || b` where both arms are calls read as `any`, because the type two arms have
in common was asked of the scope rather than of what each arm answers. The
choice of two arms is now the type both answer, so the choice of two text reads
is a text and the method written after it is a text method. The C target boxed a
text arm of `||` into the dynamic handle whatever the operator's own type was,
which put a `double` beside the `const char*` of the other arm: an arm is boxed
only where the value itself is the dynamic handle, as the `select` already
stated.

    The total went from 157 to 155.

### 4ew. A spread of a text, `Array.from` of one, and a place behind a call

    [...printable].slice(0, n).join("")
    Array.from(text)
    this.frame().block.releases.unshift(name)
    Object.hasOwn(TABLE, key)

A text spread into a list was the text itself, so the methods written after it
were methods of no list. `[...printable]` is now the characters of the text —
the fields the split helper cuts at the empty separator — and `Array.from` of a
text is the same call. `Array.from` of a list is the slice from its first
element on, which is a block of its own.

A list a *field behind a call* names was refused as a place a shift or an
unshift writes, because the write knew only a name and a field of one: the value
is read once into a name of the statement's own, and the list is written through
the field of that name, so the call runs the one time the source wrote it.

`Object.hasOwn` is the question `Object.prototype.hasOwnProperty.call` asks,
written as the static the modern sources use: it reads the same comparison chain
of the names a constant record wrote.

    The total went from 161 to 157.

### 4ev. A number read in its radix and a text of a code point

    Number.parseInt(text, 16)
    String.fromCodePoint(code)

`Number.parseInt` was refused as no function of `Number`, and
`String.fromCodePoint` as none of `String`. The first is the number a text
states in the base the call names, read as a runtime entry that skips the
whitespace in front of the digits, takes an optional sign, and answers NaN
where no digit in the radix is there. The second is the text of one code
point, encoded as the UTF-8 bytes of the value and handed back as a managed
text. Both are declared beside the other text entries, so every backend
reaches them the way it reaches a slice or a trim.

    The total went from 163 to 161.

### 4eu. A nested map a class field writes is the map it was written as

    readonly reads = new Map<string, Map<string, number>>()

A field written as a nested map was read at `any` where the source wrote no
annotation: the scanner that skips a field's type arguments stopped at the
`>>` of the inner map, so the field's type ended where the inner map ends, and
a value read through a loop that walks `values()` was an instance of no class.
The nested angles are skipped whole, and a loop that binds an instance binds
the class it is, which is what the field read asks.

    The total went from 165 to 163.

### 4et. A text read at a byte position is the code point there

    character.codePointAt(0)

`codePointAt` was refused as no method of a text. It is the character at the
byte the source states, written as the number it is, decoded at run time from
the UTF-8 value there. A text is walked by character, so the loop that walks
one binds a text of one character, which is what `codePointAt` is asked of.

    The total went from 166 to 165.

### 4es. A whole number wrapped from a value that is a whole number reads

    BigInt.asIntN(64, BigInt(text))
    BigInt.asUintN(64, (BigInt(x) << 32n) | BigInt(y))

`BigInt(text)` was left as a call of no type, and a binary over `BigInt`
calls was read at `any` because the scope alone does not hold the type the
call answers. The digits a text states still answer the call the source
wrote, held at the whole number it is, and a binary over whole numbers is a
whole number, read from what its sides answer rather than from what the
scope holds.

    The total went from 169 to 166.

### 4er. A number question reads its value twice where the value is a maths read

    Number.isInteger(Math.log2(x))

A number question asks its value more than once, so a value that is a call
was refused. A maths function reads the number it was handed, so asking
twice is asking the same question, apart from `Math.random`, which answers
anew each time it is asked.

    The total went from 170 to 169.

### 4eq. A typed array built from a list of numbers is the list written as its elements

    Uint8Array.from(machine.rodata)

A typed array built from a list of numbers was refused where the list's
element and the array's are not the same: the copy is each number written as
the element the array holds, allocated where it is written and copied where
it lies.

    The total went from 171 to 170.

### 4ep. Entries sorted is the record the comparator orders

    Object.fromEntries(Object.entries(r).sort(([a], [b]) => ...))

Sorting the entries is sorting what the record holds: an order of its
positions is sorted by the answer the callback wrote, reading each entry as
the callback read it, and the record is written in that order. The `valueKey`
statement that sorts still refuses for its replacer, so the report does not
yet move for the sort alone.

### 4eo. The captures a pairs callback reads are the helper's own

    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n]))

A callback that reads what the function around it holds was refused wherever
it answered a pair: the helper that inlines the pair looked for the entry at
the first parameter, which is the first capture where the callback captures,
and read the entry as a capture. The entry is the one the callback was
written with, and the captures are handed to the helper beside the walked
value, which is what an arrow's own lifting does.

    The total went from 176 to 171.

### 4en. A map entry written as an asserted tuple is the entry it asserts

    new Map([[k, v] as [string, number]])

An entry written as `[k, v]` and asserted as `[string, number]` is the entry
it asserts: the type is erased like every other assertion, and the pair is
read. Without it the `as` was the next pair's start, and the list was refused
where the entry ends.

    The total went from 178 to 176.

### 4em. An async method of an object literal states its type parameters

    { async read<T>(path: string): Promise<T> { ... } }

An async method written with type parameters was not read as one: the `async`
branch required the `(` the method's name is followed by, and a generic method
is followed by `<`. The type parameters are erased with every other type, as a
non-async method's are, and the method is read.

The report went from 176 to 178, because the methods the desync had hidden are
real work: a module-scoped counter the methods write, the host's `stat` and
`readdir` answers, and a `map` over the entries they name.

### 4el. A for loop whose step is an assignment is the while it writes as a for

    for (let open = ...; open >= 0; open = ...) { ... }

A header that names the index and compares it with a bound was read as the
counted loop, whose step is the index moving by one or by a count. A step that
is the assignment the source wrote is not that step: the header is read again
as the while loop it is, with the initialiser before the loop and the step
last in the body.

    The total went from 177 to 176.

### 4ek. The entries of a source assigned into a dictionary

    Object.assign(layouts, other)

`Object.assign` over dictionaries copies the entries of each source into the
target in order, so a later source overwrites an earlier key the way the
language overwrites it. Where the target is a dictionary the call becomes the
helper that writes each entry into it and answers it; a record target copies
its fields field by field, which this slice does not take.

    The total went from 178 to 177.

### 4ej. A promise that answers nothing leaves no value to collect

    await Promise.all(Array.from({ length: workers }, () => worker()))

`Promise.all` over promises that answer nothing was refused: there is no value
to collect. Each one is now awaited in order and nothing is gathered, which is
what the source awaiting the call and discarding it means. The call answers
nothing.

    The total went from 179 to 178.

### 4ei. A list of lists flattened is the lists it holds one after another

    module.data.flat()

`flat()` was refused as no method of a list. It is the concatenation of the
lists the outer list holds, each inner list walked where it is read and its
elements appended to the answer, which starts empty and carries the element
shape the inner lists hold.

    The total went from 180 to 179.

### 4eh. A text searched backwards asks at the last asking

    path.lastIndexOf("/")

`lastIndexOf` was refused as no method of a text. It is the last position the
needle is asked at, walked in order from the beginning to the position the
source states — the end of the text where it states none, clamped the way the
language clamps it — keeping the last hit of the field the needle is long,
compared with the needle, which the helper walks with `text.slice`.

    The total went from 181 to 180.

### 4eg. A program walks a value that is not a bare name

    for (const file of phase.program.files) { ... }

The `for...of` span of the program parser had the name of the buffer to walk
and no more, so a walk over a member chain was refused where the name ended.
A value that is a bare name walks as it was; any other value is read into a
name of the statement's own first, in a block of its own, so the walk reads the
name it was read into and everything downstream can keep counting on the walk
reading a name.

    The total went from 186 to 181.

### 4ef. A union keeps the records it mixes with its values

    type Value = bigint | number | boolean | string | null | BufferValue;

A union that mixed records with values of other kinds resolved to its first
member only, so after the guards eliminated the values the record the
remainder was had no fields the read could see, and a method of a field of
the record was refused. The union now keeps every member as an arm beside the
merged fields when any member is a record, so the remainder is still the
record and a field of the record reads as it does on the record itself. A
union of no record at all is the first member it was.

    The total went from 188 to 187.

The working tree then showed one refinement: a debug print that had been
left behind in the frontend vanished, taking its own refusal with it.
The total went 187 to 186 on the same slice once it left.

### 4ee. A text splits at most as many fields as its limit names

    literal.split("\0", 1)

The split helper cut every field a separator named, and a limit was refused
where the call was read. It now takes the limit as a third parameter and
keeps at most that many fields — none where the limit names none — so the
list it answers is the first that many fields of the cut. The no-limit form
is the helper it was; only the key it is written under says the limit is
there.

    The total went from 189 to 188.

### 4ed. A text replaces the asking of its needle

    request.replace(`run`, `bench 2`)

A text method `replace` with a written needle was refused. It is the text
before the first asking of the needle, the replacement, and the text after
it — the three the language joins — and it is written over `text.indexOf`,
so a text needs no new service: a needle that is not there leaves the text
it was asked of, and the empty needle asks at the beginning. A regular
expression was already taken above, by the regex reading.

    The total went from 191 to 189.

### 4ec. A spread stands beside a value in Math.max

    Math.max(n, ...xs)

The fold `Math.max(...xs)` read only a spread that was the whole of the call:
a value argument beside the spread was a spread argument outside the call
subset, and the call was refused. The call now scans its arguments for a
spread; where one stands, every value beside it joins the list it precedes
or follows — a value as a list of one — and the fold runs over the joined
list. A call with no spread is the two-argument builtin it was.

    The total went from 192 to 191.

### 4eb. A list is reversed where it lies

    block.statements = kept.reverse();
    sides.reverse();

`reverse` was refused as no method of a list. It is the collection method
the frontend writes a helper for, like `fill`: the helper walks two ends to
the middle, swapping each pair once, and answers the list it wrote. The
elements keep the shape they were read at, so a chain of the reversed list
reads its fields the second time.

    The total went from 194 to 192.

### 4ea. Date.parse reads a date text back

    Date.parse(build?.updatedAt ?? "")

A date text is read to the milliseconds since the epoch by the runtime —
`blaze_rt_date_parse` — which answers NaN where the text names no date: it
parses the ISO form over a proleptic Gregorian calendar with the days-from-
civil arithmetic, taking the zone the text ends in as what its UTC answer
hangs from, so a text that names nothing settles to nothing. `Date` joins
the namespaces a call may name, and `Date.parse` is the builtin that names
the runtime entry.

    The total went from 196 to 194.

### 4dz. Promise.all settles a list into the values it carries

    const written = await Promise.all(found.map(async (entry) => pair(entry)));

`Promise.all` was refused as no method of `Promise`. It is read as the helper
that settles each element of its list in order with the same `await` the
source would write, and collects the payloads where they were written: for
elements already carrying their payload it is the list itself, and for
elements still behind a promise it is the value the promise settles to.

    The total went from 197 to 196.

### 4dy. The await of a call through an interface member

    const found = (await store.list("x")).filter((entry) => entry.startsWith("a"));

The member call of an imported interface is read as an `invoke` of the
signature the member declares, and its `await` lost the payload: the reader
typed the awaited value by the name the call was declared under, which an
`invoke` does not carry, so the filter's element was a number and the map of
the filter's answer was refused as no method at all. An await now reads the
`returns` of the invoke it unwraps (through `Promise<T>` where the call names
it), `memberFunctionType` keeps the shape the member declares beside the
call, the deferral of an unlinked read follows through `Promise.await` to
the call it waits on, and an `invoke` whose callee member no layout holds a
field for is refused at the IR rather than built as a jump to the object
itself.

    The total went from 198 to 197.

### 4dx. An object spread in a program body

    const o = { ...{ a: y }, b: 2 };
    const p = { ...(flag ? { recompile: true } : {}) };

The program parser read an object literal field by field and had no spread in
it, so `...` was refused where a field's name was expected. A spread is now
read beside the fields and kept in the literal: a spread of an object literal
writes that literal's fields, and a spread of a conditional writes the fields
either arm writes, which the layout pass expands when it files the shape. A
spread of a value whose fields the pass cannot read takes no part in the
shape, the same answer it gives a method a literal writes in shorthand.

    The total went from 200 to 198.

### 4du. A record built from a callback's pairs### 4du. A record built from a callback's pairs

    Object.fromEntries(units.map((unit) => [unit.name, unit]))

`Object.fromEntries` copied a map or a record, and a list of pairs was refused
because an entry is two values of two types and a compiled list holds one. The
call is now read as the loop of writes it means, with the pair machinery
`new Map(list.map(...))` already has: the callback is read against the element
the list holds, the pair it answers is its result, and the helper loops the list
and writes one entry per element. Nothing of the pair exists at run time. A call
may end its arguments with a comma, so a map call followed by one is still the
only argument.

The arrow is read where its pair is, which means the arrow is never called: the
closure the read lifted is dropped, because a list of the two values of a pair
is not a list a backend can write. That applies to `new Map(list.map(...))` as
well, where the closure was left behind before.

The total went from 206 to 204.

### 4dt. A hash is the runtime's SHA-256 hasher### 4dt. A hash is the runtime's SHA-256 hasher

    createHash("sha256").update(text, "utf8").digest("hex")

The compiler's fingerprint, every candidate key and the cache key are SHA-256
digests, and the runtime carried only MD5: `createHash` was a name no function
of the program declared. The runtime now carries SHA-256 (FIPS 180-4) beside
MD5, with the three ABI entries a hasher is, and the frontend lowers the chain
to them: `createHash("sha256")` is the handle the runtime made,
`hash.update(text)` feeds it and `hash.digest("hex")` answers the digest. A name
a hasher is bound to is a handle too, so a chain written as statements reads the
same. An algorithm other than sha256 is refused by name.

The runtime test checks the digests at the lengths the padding is a question at
— nothing, fewer bytes than the length field, the fifty-six bytes that start a
second block, a full block and more than one — and two updates are the digest of
the two texts joined.

The total went from 213 to 206, and `core/json-store.ts` reads whole.

### 4ds. A promise a method answers### 4ds. A promise a method answers

    async list(path: string): Promise<string[]> { ... }
    const found = await store.list(path)          // the list the promise carries

An async function's annotation is read as the value the promise carries, and a
method's result is a text the class scan kept whole: `Promise<string[]>` was
`any`, so the value the await held was no list and its methods were refused. The
payload is peeled from the method's result text the way it is peeled from an
async function's, and the await of a method call reads the type and shape the
call itself was written at, which the declaration table does not hold for a
method.

No refusal changed; the call is the value it always was, and this is what the
wait reads out of it.

### 4dr. A reference a program body hands to a function### 4dr. A reference a program body hands to a function

    console.log(`${checksum(createTree(3))}`)     // a node, handed to `any`

A function a program body calls has a parameter type the body does not write,
and the driver's call passed each argument as the type the argument happened to
have. A node builder answers `ref<Object1>` — a pointer — and the walker takes
`any`, which the C backend carries as the double the ABI holds a value in: the
pointer was handed over as a pointer to a parameter read as a double. The call
is now placed in the type its parameter takes, and the two reference
conversions are the target's: the C backend boxes a pointer into the double a
dynamic value is and unboxes it back, while the machine backend holds every
reference in a register as the pointer it is and needs neither. The declaration
the driver writes follows the same rule, so the machine build declares a
reference as a pointer and the C build declares an unshaped one as a double.

No refusal changed; the program a body calls a function from is the one that
has to run it, and this is the call it makes.

### 4dn. An empty list a loop walks beside a set### 4dn. An empty list a loop walks beside a set### 4dn. An empty list a loop walks beside a set, an answer that names nothing, and a module read after its imports

    values ?? []                          // walked as the dictionary it is
    c ? [] : values                       // no entries where the set is absent
    fields.flatMap((f) => { if (...) return []; return [f]; })
    result.failures.map(...)              // the shape the declaring module resolved

An empty list has no element of its own, so the use has to say what it holds.
A `for..of` over `values ?? []` or `c ? [] : values` where `values` is a set was
refused: the set is one handle on the runtime's dictionary and the empty list is
a block of elements, so the loop cannot walk the choice as one value. The choice
is now read as the set — the absence of a set is the zero handle, and the
runtime's `len` of no dictionary is zero — so the loop takes the arm that names
the set and the arm that writes nothing is no turns. A loop that walked the
empty list as a dictionary would have read an element of a block as an entry.

An unannotated arrow that answers `[]` on one path and a value on another was
refused: the returns were read before the arrow had a result type. The empty
list says nothing about what the function answers, so it is not the witness the
result is inferred from; the returns that write values are, and the empty list
is then built at that type.

A signature the module graph hands a caller carries the shape its declaring
module resolved, and a module read before the module that declares the type its
result names states no shape at all. The second read — the one that replaces
each file's analysis once the imports are bound — walked the records in
discovery order, so the entry was read before the modules it imports. It now
walks them in dependency order, so `verify()` returning `Result` from a third
module answers a list at `result.failures`, and the contract's `ref<any>` no
longer erases a field a caller reads. A map whose value names a class answers
the fields of that class, which the class table states and the type table only
names.

The total went from 231 to 220. The `"map" is not a method` group fell from
eleven to six, and `semantics/module-graph.ts` reads whole.

### 4di. A map of the pairs a callback writes### 4di. A map of the pairs a callback writes

    new Map(items.map((item) => [item.key, item.value]))

An entry of a map is two values of two types, and a list here holds one element
type: `items.map((item) => [item.key, item.value])` was a list of pairs a
compiled list cannot hold, and the call was refused. The map is now read as the
loop of writes it means. `new Map(<list>.map(<callback>))` is recognised at the
token level — the argument is exactly a `.map(` call that closes where the map
does — and the list is read to the `.` and no further. The callback is read
against the element the list holds, and the pair it answers is its result: a
list of two written values. The helper the call becomes loops over the list and
writes one entry per element, with the callback's parameters read as the element
the loop is on. Nothing of the pair exists at run time, which is what makes a
pair of two types possible at all.

The total went from 261 to 251.

### 4dh. A push on a choice of two places, and the keys of a layout

    (c ? this.statics : this.fields).push(name)   // the place it names
    Object.keys(reported)                         // the fields it was laid out with

**A push on a conditional.** The receiver of a push is a place the statement
writes back into, and a conditional names two of them. The push is the push on
whichever the condition chooses, so the statement it becomes is the `if` over
the two writes: each list is grown where it is the one the source meant.

**The keys of a layout.** A value the read holds at a record is a layout: its
fields are the keys it was laid out with, and a key the program wrote only when
a condition held is still a field of it. `Object.keys` is the list of those
names and `Object.values` the fields read, which is a list only where every
field is the same type.

**An await holds the record its promise carries.** `async function f():
Promise<Outcome>` states the type the promise carries, which is the shape a
caller's `await f()` holds. The annotation's shape was resolved over the whole
`Promise<Outcome>`, which names no declaration, so the awaited value was the
unshaped reference and a field or a spread of it was refused. The payload is
peeled before its shape is resolved, and `await` of a call reads the payload's
type and shape.

The total went from 271 to 261, and `semantics/typescript-classes.ts` reads
whole.

### 4dg. A conditional spread into a union of shapes

    { k: `num`, ...(yes ? { async: true } : {}) }    // an arm of a union

The zero a conditional spread writes (§4db) is the field's type, and the type of
a field of a union of shapes is the union layout: every arm's fields, with the
ones the source did not write laid out as their zero. Reading the spread's arms
at that same shape therefore padded both arms with every field, and neither arm
was the one that wrote — the spread was refused by its own padding. An object
read at a union now says which fields the source wrote, and the spread is read
from those: the arm that writes nothing is the arm that wrote nothing.

Nineteen refusals went, and `semantics/typescript-program.ts` reads whole.

### 4df. A wrapped whole number, the default order, and a view of part of a block

    BigInt.asIntN(bits, value)             // the low bits, sign extended
    BigInt.asUintN(bits, value)
    a.sort()                               // the order `<` gives the elements
    new Array<T>(n)                        // the type erased before the count
    new DataView(bytes.buffer, at, 4)      // a window of four bytes

**A whole number wrapped to a width.** `BigInt.asIntN(bits, value)` keeps the
low `bits` of a whole number and carries the sign of the highest of them up;
`asUintN` keeps them as they are. The width is a number a program computes —
`integerBits(name)` in the contract evaluator is — so the wrap is the runtime's:
one entry point for each, over an `i64`. A width of the whole carrier is the
number itself. The Nim adapter answers both.

**Texts are ordered by what they say.** A comparison of two texts is the text
operand the backends already lower, but the read gave every ordering the
comparison of two numbers, so `a < b` over two texts was a comparison of a text
as an f64. The two sides of an ordering are read as texts when both are.

**`a.sort()` with no comparator.** The order the language gives a list of
numbers or of texts is the one `<` is for each, so the insertion sort is written
with that comparison where a comparator would be called: numbers by their value
and texts by what they say.

**A typed allocation states its element type.** `new Array<T>(n)` is the count
the source wrote; the type is erased before the count is read.

**A view of part of a block.** `new DataView(bytes.buffer, at, 4)` is the block
moved by the offset and as many bytes as the source wrote of it, which is the
window `bytes.subarray` already produced.

**A typed array built from a list is the list.** `Uint8Array.from(list)` and the
views beside it name the block of one element type, and a list of that type is
already one. **`a.concat(b)`** is the list `a + b` is: each is a block, and the
sum is a block of both.

The total went from 299 to 290.

### 4de. A method of an object literal, and an element of a field

    const counter = { add(by: number) { total += by; } }   // a method
    this.counters[kind] += 1                              // an entry of a field
    all.unshift(...bindings)                              // the front of a list
    line.split(` `).pop()                                 // the last of a value

**An object literal's method.** `{ start(controller) { ... } }` is a field named
by the key holding the arrow its body is, which is the value the compiler
already has for a function. A method may state type parameters, which are erased
with every other type, and its result type ends where its body's brace begins —
the one place an annotation ends at a brace rather than at a `=>`. The field is
what a call through the object reads, so a method written this way is called the
way a function-typed field is. This was also the parse that failed: the
`expected "}"` on those files left everything after the literal unread, and a
top-level `function` after it was reported as one declared inside a function.

**An element of the object a field holds.** `this.counters[kind] += 1` writes an
entry of the record the field holds. The object is a reference, so the write
goes through a name of the statement's own and lands in the same object; a
record's entry is the dictionary's, so a compound write is the entry read and
the operator applied to it, and the write is the dictionary's own.

**The front of a list with a spread.** `all.unshift(...bindings)` writes the
elements of the list it names in front of the list, which is the concatenation
the two lists added are; `push(...xs)` already did that.

**The last element of a list no name holds.** `line.split(` `).pop()` is the
last element of the list the call answered: read into a name of its own, and the
answer is its last element, or the zero of its type where it holds none.

The total went from 306 to 299, and `toolchain/assembler.ts` reads whole.

### 4dd. The clock, and the bytes of a text read back

    new Date().toISOString()          // the host's clock, written as ISO 8601
    Date.now()                        // the milliseconds it is
    new TextDecoder().decode(bytes)   // the text the bytes are

**A date is the clock.** A source asks a date for two things: its stamp and its
time. Both are runtime answers: `blaze_rt_now_ms` reads the wall clock in
milliseconds, which is the number a date is held as, and `blaze_rt_timestamp_iso`
writes it as the UTC ISO 8601 text the language writes. `new Date(ms)` is the
milliseconds the source wrote, and `Date.now()` the same clock. A date held as a
value of its own is the host's `Date`, which this compiler has no value for, and
stays refused. The Nim adapter answers both from `std/times`.

**A text decoder reads bytes back as text.** `new TextDecoder().decode(bytes)`
is the text those bytes are written as, and the one encoding a compiled text is
written in is utf8: the bytes are copied into a managed string by the runtime's
own `blaze_rt_string_new`. A decoder is no value of its own — `const decoder =
new TextDecoder()` holds a zero nothing reads — so what the read has to know is
the name it was bound to, which the read types with the marker the decoder is.

The total went from 319 to 306.

### 4dc. A map under a number key, a window of a block, and the bytes of a text

    new Map<number, number[]>()                // the key is the number
    bytes.subarray(from, to)                   // the block, moved
    Buffer.byteLength(text, "utf8")            // the bytes a text is

**A map under a number key.** The dictionary's number key is the bits of the
double written as text, and the sequence-valued entry points were written for a
text key only. The same two entries are now written for a number key, which is
the key the number-valued entries already use, and the read asks the key it was
declared with. Five refusals in `toolchain/ir-wasm.ts` were maps of byte arrays
keyed by number.

**A window of a block.** `bytes.subarray(from, to)` is the block another value
holds, moved by the offset and as long as the source wrote of it: the IR's
buffer already had a `view` for a window of a block, and nothing in the frontend
produced one. The read now produces it, the element size says which arrays are
blocks of bytes a window may reach, and a length of a window is the count it was
taken at rather than a header it does not have. A view of any sequence is a
window, which is what a typed array bound to a name is.

**The bytes of a text.** `Buffer.byteLength(text, "utf8")` is the number of bytes
the text is written as, which the runtime already measures for a managed string
and a literal alike; the encoding a source writes is the one a text is.

The total went from 341 to 319, and the two together with the conditional spread
of §4db are one batch.

### 4db. A conditional spread writes the zero of the field it leaves out

    { ...(c ? { async: true } : {}) }      // a truth the object may not carry

Sixty-three refusals were one construct: an object literal that spreads a field
only when a condition holds. The `? {} : { field: v }` form was read only where
the field's type had `null` for its zero — a reference — because the compiler
had no value that says "absent". It does not need one: a record here is laid out
field by field from the type it is held at, so a field the literal leaves out
*is* the zero of its type, written by the object pass when the object is built.
The spread now writes that zero explicitly — false for a truth, 0 for a number,
the empty text for a text, the empty list for a list, null for a reference —
which is the value the field would have held anyway. A condition that holds
false therefore leaves the object the object pass would have built, and the
sources' `...(c ? { bigint: true } : {})` is read.

The object pass had to learn the same shape for a choice of two lists: an empty
list written out is an array of no length and one a name holds is a slice, and
`describe` saw them as different, so the field was laid out as the unshaped
handle. Two sequence arms of the same element are now the slice they are.

The total went from 359 to 341.

### 4da. A map of lists, a declaration read before it is written, and a push on an element

    const kinds = new Map<string, string[]>();   // an entry is one double
    kinds.set(k, seen);                          // the list is copied
    const seen = kinds.get(k);                   // the block, or NULL
    const walk = (b) => walked.add(b);           // the set declared below it
    const walked = new Set<Block>();
    positions[i].push(kind);                     // the element written back
    items.slice()                                // the list copied

**A map of lists.** A dictionary entry is one double, and a list is a block and
a length, so a map could hold no list at all: `a map here holds a slice<text>,
which a key cannot answer` was the largest single cluster left. The block is
now what the entry carries. `m.set(k, list)` copies the list into a block the
runtime laid out and stores the pointer; the copy matters twice, because the
block's header says how many bytes it holds — which is the length the read
answers — and because a list written out at the call site is a block of the
stack its writer frees. `m.get(k)` answers that block, typed as the list the map
holds, or NULL where the key is absent, which is the `undefined` the language
reads. `has`, `delete`, `size` and the keyed entries are the dictionary's own.
Two ABI entries carry it (`blaze_rt_dict_set_seq`, `blaze_rt_dict_get_seq`) and
the Nim adapter answers both. Nineteen refusals went at once, and with them the
`set`, `push` and empty-list refusals that followed from a value of no type:
the total fell by forty-nine.

**A declaration read before it is written.** `const walk = (x) => walked.add(x);
const walked = new Set<Block>();` is a body the sources write: the binding is
hoisted to the block and the closure runs after the declaration. Reading the
block left to right made `walked` a name of no type, and every method written on
it was a method of nothing. The declarations at a block's own level are now read
before its statements — the annotation, the `new Set<...>()` it allocates, the
class it names and the signature it states — and the declaration itself then
confirms them.

**A push on an element of a list of lists.** `positions[i].push(kind)` is a push
on the list the element holds, and the grown list is written back at its index:
the element is read, grown, and assigned. `a[i] = v` already wrote through a
name, and this is the same write with the append on the right.

**`slice()` copies.** `a.slice()` is `a.slice(0)`: from the first element to the
last. The method took one or two arguments, so the whole-list copy — which the
compiler's own sources write in the arrow default it fills — was refused.

**A concatenation of nothing is zero long.** `a + []` allocated one element of
room when the sum was empty, so the block's header said one element and a length
read off it answered one. A block of no elements is a block of no bytes.

The total went from 408 to 359, and `ai/model.ts` and
`semantics/whole-numbers.ts` read whole.

### 4cz. A coalesce that keeps a collection, `Object.is`, and a re-export

    offsets.get(i) ?? new Set<number>()     // a set either way
    Object.is(a, b)                          // the same value, not `===`
    x.toString(16).padStart(8, "0")          // a hex text is a text
    export { availableParallelism }          // an imported name offered
    export { f as g }                        // offered under another name

**A coalesce keeps the collection one of its arms names.** `m.get(k) ?? new
Set()` is a set, but `shapeOf` read the whole as the *contract* type of the left
arm — the opaque reference a set is carried as — so `collectionOfExpression`
answered nothing for it and `add`, `has` and `size` were methods of no type.
The coalesce asks each arm for the collection it names, and a declaration whose
initializer is one records the collection it holds; the two together cleared
seventeen refusals across six files, because `x ?? new Set()` and
`x ?? new Map()` are how the compiler's own passes start an accumulator.

**`Object.is` compares two numbers by their bits.** The language's same-value
question differs from `===` twice: a NaN is the same as itself and `-0` is not
`0`. Two numbers are compared by the runtime's `blaze_rt_number_same`, which
compares the eight bytes; two texts, truths or references answer `===`, which
already compares texts by what they say. The ABI entry is one C function, and
the machine backend calls it through the same symbol.

**A `fixed` value is a text.** `x.toString(16)` is lowered to a `fixed` value,
and `shapeOf` knew `text` but not `fixed`, so `padStart` written on a hex text
was not a text method; the value is also a pure read, so a method that needs it
twice may ask twice.

**A module offers the names it imports.** `export { availableParallelism }`
where the name was imported is a re-export, not an export of a declaration the
file does not have. The name resolves through the import's specifier, and the
list's `as` is carried: `export { f as g }` offers `f` under `g`, which
`declaredOffered` and `classOffered` follow through a re-export as well as
directly.

The total went from 428 to 415, and `core/platform-node.ts` reads whole.

### 4cy. A default a call may leave out, a padded text, and the shape a slice keeps

    const bump = (x: number, by: number = 1) => x + by;   // a default
    for (let at: number = from; ...)                      // an index with a type
    name.padEnd(16)                                       // a padded text
    sections.slice(1).map((s) => `  ${s.name}`)           // a list's elements

**An arrow's parameter takes a default.** The default is written where the arrow
is and used where the call is, so a *value written out* — `null`, `false`, `0`,
`""` — is the same value at both: the call writes it where it left the parameter
out. A default that reads a name is that name in the arrow's own scope, which
the call does not have, and is refused as before. The compiler's own sources
write exactly the literals, so `(name, shape = null) => ...` is read now.

**A for loop's index states its type.** `for (let at: PlacedBlock | null = from;
...)` is the counted loop with the annotation the source wrote; the annotation is
erased like every other, and the loop reads the value at the `=`.

**A padded text.** `text.padEnd(width)` is the text and the fill — a space where
the source names none — repeated as many times as the width is short by. The
fill must be one character, since a longer one is truncated by the language and
a repetition is not.

**A list method that keeps its elements keeps their shape.** `slice` answers a
list of the elements it kept, but only `at` and `find` carried the element's
*shape*: `sections.slice(1).map((section) => section.name.padEnd(16))` had an
element of the opaque reference, so the callback's `section` was a value of no
type and every method on it was refused. `slice` now records the list's element
shape on its answer, as `filter` and `sort` already did.

**A boxed text passed to a text parameter.** A text local is held in a cell so
that a nested function can write it, and the C backend hands the cell to a
parameter declared `boxedtext`. It handed the cell to *every* parameter, so a
call of a helper that takes the string itself was given `char**` where
`const char*` was expected — an incompatible pointer the C compiler only warns
about, which reads as a pointer where a string was expected. The parameter's
declared type now decides. (A separate, older bug remains in the inliner for a
body with a boxed text: joining a repeated text with `+` prints garbage or
crashes. It is not this slice's and is written down here.)

The total went from 432 to 428.

### 4cx. A string is not a bracket, and a function type is a signature

    if (text === "(" || text === "[") ...          // a string, not an arrow
    ): readonly { name: string }[] {               // a type, not the body
    c ? (value as T) : other                       // a value, not an arrow
    export const SAVED: readonly number[] = [...]  // the annotation, kept
    const strip = createCommentStripper();         // a name held at a signature
    strip(raw).trim()                              // the call the signature states

Seven readings, and one of them changed the report by more than a hundred
refusals' worth of code being read at all.

**A string is not a bracket.** `if (text === "(" || text === "[")` writes the
character as the text it is, and the token that holds it is a *string*.
`arrowAt`, which decides whether a `(` begins an arrow's parameter list, compared
the token's text and not its kind, so the string `"("` was read as the bracket,
its `)` was found in the unrelated code that followed, and the next `=>` in the
file made it an arrow. The statement's remaining tokens were then read as that
arrow's body — and every method of the compiler's own parser that compares a
character to a bracket was refused from there. A bracket is punctuation; a
string is a value. (`bodyAfterReturnType` and the constant scan had the same
class of bug for `>>`, below.)

**A return type that is a readonly list of records is not the body.** A class
member's body is the brace `bodyAfterReturnType` finds after the result type.
`): readonly { name: string }[] {` writes `readonly` before an object type, and
the brace after a word was read as the body: the method's body became the type,
and every member after it was lost — which is why `this.valueTypeOf(...)` inside
the class was "not a method this program compiles" for methods the class does
declare. `readonly` is the one modifier a class writes before an object type,
and it is now part of the type.

**A conditional arm in parentheses is not an arrow.** `c ? (value as T) : other`
writes a `:` after a parenthesised value, and `arrowAt` read it as an arrow's
result type: the scan for the type's end only stopped at `=>`, so it ran to the
next arrow in the file and took the arm for one. A `,`, `;`, `)`, `]`, `}`,
`?`, `:`, `=` or a logical operator at the type's own depth ends an annotation
too, and each is now a stop.

**An annotation the constant scan keeps.** `export const NAME: T = ...` is a
constant of the file with the type it writes, and the scan that turns a
declaration into a constant skipped the word `export` by skipping to the next
statement — which lost the constant *after* every `export interface` as well.
`export`, `declare` and `default` now skip only themselves, an interface body is
skipped as a whole, and `>>` closes two type arguments in the annotation:
`Record<string, Record<A, B>>` had left the scan's depth open, so the `=` of the
value was never found and the declaration after it was lost with it.

**A function type is a signature.** No contract type spells a function, so a
result or a parameter declared as one was erased to the opaque reference. But a
signature is what a call is read against: `const strip = createCommentStripper()`
holds the `(line: string) => string` the declaration answers, and `strip(raw)` is
that call, so `strip(raw).trim()` is a text method. The signature is kept beside
the types, declared functions answer one, and a call of a name reads the
arguments and result the signature states. A parameter declared as a function is
the same thing for its callback: `walkValues(value, (one) => ...)` hands `one`
the type the declaration gave the callback, and the signature crosses the link
with the rest of the import — a function-typed *parameter* was erased there even
when the declared result's shape was already carried.

**A class crosses a type-only import, and a re-export.** `import type { Logger }`
names a class the file reads through a value it was handed; the methods written
on that value are the class's, and nothing is imported at run time either way:
what crosses the link is the description. The same description is followed
through `export { Logger } from "./x.ts"`, and since a module that imports a
class also offers it, the binding runs to a fixed point — which module is read
first is not fixed.

**An export list may rename.** `export { sleep as setTimeout }` offers the value
it names under the name the `as` writes; the list was read as a list of plain
names, and the `as` ended it.

The total went from 447 to 432, and `toolchain/asm-text.ts` and
`semantics/region.ts` read whole. The arrow fix alone was worth twelve
refusals, because the parser had been refusing its own source from the first
comparison to a bracket.

### 4cw. A field through a reference, the shape an assignment reads, and `Array.from`

    const body = statement.loop.body;            // the declaration the cycle names
    v = { k: "call", name: "x", args: [] };      // read at the shape `v` declares
    for (const rule of RULES) ...                // the constant the file wrote
    "k" in n                                     // the key the source holds
    Array.from({ length: n }, (_, i) => v)       // n answers, at their indexes

Several readings, each its own construct.

**A field through a reference.** A record is expanded with the declarations it
is currently inside marked, so a type that names itself writes a `ref` where the
cycle closes. `fieldOfType` marked the declaration as seen *before* handing it
to the expansion, so the expansion answered that reference and a field of it was
not written: `statement.loop.body.statements` stopped at `ref Block`, and every
list method on it was a method of nothing. The expansion marks the declaration
itself, and the caller no longer marks it first. The `ref` that remains in the
expansion is the recursion, and resolving it in the field's own table is what
reads the field.

**The shape an assignment reads.** A name whose declaration names a union of
shapes is held at the contract's opaque reference, and the shape lives beside it
in `valueShapes`. An assignment read its value at the contract type alone, so
`v = { k: "call", ..., args: [] }` had no field type for `args` and the empty
list was unsettled. An assignment now reads at the shape the declaration named,
so the object literal is read field by field and an empty list takes the
field's element type. The shape is the *declaration's*: narrowing is kept in its
own table, so a write is read at the whole type and not the arm a guard settled.

**A for-of over a constant.** A loop whose source is a name read the element
from `valueShapes`, which only a declaration in the body writes. The constant a
file writes above the body is read by `shapeOf`, which the index read already
asks: the loop and `RULES[0]` now keep the same record, and a list field of one
element is the list the body maps.

**A key held in a name.** `` `key in record` `` was answered for a key written
out, and for a value that is a dictionary; a record of fields with the key in a
name was refused. Every field a record declares is laid out, so the answer is
whether the key names one of them: the chain the written key's path builds,
with the key asked once per name. A key that runs on every mention is refused
the way the written key's path refuses it.

**A record a value is asserted to be.** `value as Record<string, unknown>` names
the dictionary the value is, but the assertion was erased and the `unknown` the
declaration wrote was all a `key in value` could see. An `as` now keeps the
shape it names beside the value (a `satisfies` does not: it promises nothing the
value did not already say), so the question is the dictionary's `has`.

**`Array.from({ length: n }, (_, i) => v)`.** The count is read once, into a
helper that allocates it and writes the callback's answer at each index. The
callback is handed the element at the index and the index, and a sparse list's
element is the absent value — which the value model has none of. A callback that
*reads* its element is therefore refused rather than handed a number the
language would not hand it; the form the sources write, `(_, i) => v`, names the
element and reads the index alone. (An earlier note said `Array.from` waited on
a list a call answers having no length; the length a list was built at is now
carried by the IR, which is what the helper allocates at.)

**A print may end its argument with a comma.** `console.log(v,)` and
`process.stderr.write(v,)` read the one argument and expect the `)`; a call's
argument list already accepted the trailing comma, and a print did not.

**The gate the benchmark's lowering writes.** The wide-number lowering fired on
a source that mentioned `splitScalarEndo` and `CURVE`, which is a heuristic over
text: the lowering's *own* source mentions both — a comment writes `CURVE.P`,
and a rewrite names `splitScalarEndo` — so the compiler lowered its own lowering
and left a source the tokenizer could not split (`unterminated regular
expression`). The gate now asks for the declarations the benchmark writes, a
`function splitScalarEndo(` and a `const CURVE`, which a mention is not.

The total went from 472 to 447, and `semantics/typescript-wide-lowering.ts`
reads whole.

### 4cv. A compound length, a local `undefined`, and a bracket in a constant

    code.length -= 2;
    const undefined: string[] = [];
    const OPERATORS = ["+", "-", "(", ")", "[", "]"];

Three smaller readings, each its own construct.

`a.length -= n` is the list as its first `len(a) - n` elements: the same write
`a.length = n` is, at the length it had less `n`. Only the plain assignment was
read, so the compound form fell through to the expression grammar and was
reported as an unexpected operator.

`undefined` names the absent value, and it is also a name a body may declare.
A body that writes `const undefined: string[] = []` reads the name it declared;
the absent value is what an undeclared `undefined` is.

`constantList` split a written-out list on its commas and read an element whose
text began with `[` as a nested list. A *string* whose text is `[` is one token
and a string, not a bracket: the list was therefore not a constant, and `find`
written on the name was a method of nothing. The element test now asks the
token's punctuation, the way the signature scan does.

With 4cu this took the total from 480 to 472.

### 4cu. The infinities, and the greatest of a list

    Number.POSITIVE_INFINITY
    Number.NEGATIVE_INFINITY
    Math.max(...values)

A number literal has no spelling for infinity, so the frontend writes the
quotient it is: `1 / 0` is the positive infinity and `-1 / 0` the negative one,
which is the float division the emitters already write as `1.0 / 0.0`.

`Math.max(...xs)` and `Math.min(...xs)` were refused as a spread argument of a
call whose parameters are not declared. They are the greatest and the smallest
element of the list, and a list may be empty: the fold starts at the identity —
the negative infinity for a greatest, the positive one for a smallest — rather
than at the first element, which an empty list does not have. The helper is a
function of the file like `repeat`'s, and the initial value is the quotient
above. `semantics/python-program.ts`, `toolchain/benchmark.ts` and
`util/sets.ts` are now read whole.

Together with 4cv this took the total from 480 to 472. (The identity read
retires the earlier note that `Math.max(...list)` was deliberately
unimplemented: the object pass accepts the quotient, so there is a correct
empty-list answer after all.)

### 4ct. A text helper is a read, and `charAt`

    source.startsWith(quote.repeat(3), start)

`startsWith` asks for the needle twice — once for its length, once for the
comparison — so a needle that is not a name or a literal is refused. A text
method the frontend lowers to a function of its own — `repeat`, `split`, the
`indexOf` that starts at a position — writes an answer of its own and nothing
else, so asking it twice is asking the same question. Those helper names are now
marked as reads, and the methods that need their argument twice accept them.
`charAt` is the one-character field a position starts, which is the slice up to
one past it, added beside `slice`.

This is the last of the batch that took the total from 485 to 480.

### 4cs. A spread of a list keeps the element's shape

    const repeated = [...counts.values()];
    repeated.map((entry) => ({ ...entry, reason: … }))

A list literal that begins with a spread takes the spread's *type* for its
element type. The contract erases a record to the opaque reference, so
`[...m.values()]` was a list of the opaque type: an element was a reference with
no fields, and `{ ...entry }` had nothing to copy. The spread's own *shape* is
now carried to the literal, so the element keeps the record the map's value type
names. `semantics/repair.ts` reads further.

### 4cr. An arrow answers the record it wrote

    lines.map((line, at) => ({ line, at })).at(0).line.trim()

`map` answers a list of what its callback answered. The element's shape was
`shapeOfTypeExpr(returns.of)`, and `returns.of` is the callback's *type*: for an
arrow that writes an object literal and names no result type, that is the opaque
reference, so a field of the answer was a field of nothing. An arrow with one
result now records the shape of the value it answers — `{ line, at }` is a
record of a text and a number — and `map` reads its element shape from it.

### 4cq. A key asks a dictionary

    if (name in args) return { unusable: `line ${line} gives ${name} twice` };

    if (source in PYTHON_TYPES) return PYTHON_TYPES[source];

`key in value` was read against the *fields* a record's type writes down. A
dictionary — `Record<string, V>`, `Map<string, V>`, an object the program builds
by key — writes no fields, so the question had nothing to compare against and was
refused. It is the `has` the dictionary's own entries answer: the key the
dictionary holds, asked of the handle the name is.

This took the total from 488 to 485.

### 4cp. A string is not a bracket

    export function open(): string { return `{`; }

    function rows(sizes: number[]): Set<string> { … }
    export function ask(sizes: number[]): boolean { return rows(sizes).has(`a`); }

The scan that reads a function's signature before its body counts brackets to
know which functions are at the top of the file. It counted a token's *text*,
and a string whose text is `{` or `}` is one token: every function written after
such a string — which the frontend's own sources write, `"}"` among the operator
tables — was read as nested inside something, so its signature was never
scanned. A call written above it answered nothing, and the method on the answer
was a method of nothing.

The scan now counts punctuation marks, the way `mark` has always answered them
for the constant scan. `semantics/typescript.ts` and the other files that write
a brace in a string read further.

This took the total from 494 to 488.

### 4co. The element a list method answers

    const target = offered.find((one) => one.path === resolved[index]);
    target.values.get(name)

`find` and `at` answer one element of a list, and the answer was held at the
element's *contract* type — the opaque reference a record spells. `find(f).values`
was therefore a field of a reference with no name, and `get` on it was a method
of nothing: `semantics/module-graph.ts` and `semantics/frontend.ts` were refused
for this alone. A list method that answers an element now records the element's
shape, so the fields of the answer are read where the list declares them. The
element a `shift` takes out is recorded the same way.

This took the total from 509 to 494.

### 4cn. The type a top-level allocation writes

    export function known(name: string): boolean { return seen.has(name); }
    const seen = new Set<string>();

A top-level `new Map<...>()` or `new Set<...>()` holds a handle the running
program has, so the name is *state* and not a constant: the scan kept the value
of a written-out collection and nothing about an allocated one. A function
written above the declaration was read before the declaration was, so `seen`
held no type at all, and `has`/`set`/`add` on it were methods of nothing. The
scan now keeps the type the allocation writes, and the read resolves it against
the table the module graph built. `semantics/python.ts` reads further.

This took the total from 515 to 509.

### 4cm. An object written into a list

    statements.push({ k: "if", then: { id, releases: [], statements: [...] } });

The element a `push` writes is held at the *type* the list declares, and a
record's contract type is the opaque reference: an object literal written there
took its fields from nothing, so an empty list inside one was a list no use had
settled. A class method's arguments already carried the declaration's *shape*
beside the type; a list's element did not. The push now passes the element's
shape, so an object literal written into a list of records reads the fields the
record states, and an empty list inside it is built at the element type.

This took the total from 518 to 515.

### 4cl. A type a module re-exports

    import type { SemanticProgram } from "../semantics/ir-resolve.ts";

    // semantics/ir-resolve.ts
    export type { SemanticProgram };

`export type { X }` where `X` is a type the module *imported* offered nothing:
the export list only marked declarations the file wrote itself. The importing
file therefore held no `SemanticProgram`, `program.bodies` was the untyped
reference, and every method written on a list field of it was a method of
nothing — `toolchain/driver.ts` and `runtime/nim-program.ts` were refused for
this alone.

A name the export list writes and the module did not declare is now recorded as
re-exported, and binding an import resolves it to the declaration the module's
own import bound. The records are walked in discovery order, so a re-export that
only the previous pass could resolve is bound on the next one: the bind repeats
until no table gains a declaration. `toolchain/driver.ts` and
`runtime/nim-program.ts` are now read whole.

This took the total from 529 to 518.

### 4ck. The list a narrowed value is, and the record a spread names

    function replaceValues<T>(node: T, …): T {
      if (Array.isArray(node)) return node.map((entry) => replaceValues(entry, …)) as T;

    const then = { ...statement.then, statements: [...statement.then.statements] };

Two readings were missing. `Array.isArray(node)` asks the runtime what the value
is, because the read cannot type it — a type parameter, an `any`, a field of a
module the graph has not linked — and the branch the test holds in was still
`any`, so `node.map(…)` there was a method of nothing. The test now remembers the
value it asked about, and the branch it holds in reads that value as a list of the
untyped reference: the element type is the one the read would have given every
element anyway. The branch the test does not hold in says nothing, and a guard
that leaves (`if (!Array.isArray(node)) return node;`) narrows the rest of the
block the way a `typeof` guard does.

A spread copies the fields of a record, and the shape a value is held at keeps
the *name* of the record its declaration writes — `Statement` for `statement.then`
— because that is what a field read of it resolves. The spread asked for a record
outright and refused the name. It now resolves the name to the record it stands
for, the way an expected type does, and a dictionary is still refused: a record
with an index has no fields to copy.

This took the total from 537 to 529.

### 4cj. The members Extract and Exclude name

    reductions?: Reduction[];
    function loopMark(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>): string {
      const reductions = loop.reductions ?? [];

`Extract<T, U>` and `Exclude<T, U>` were names the type reader did not know, so
a parameter written at one held nothing: `loop.reductions` was `any`, the `??`
had no element type to settle the empty list with, and the list was refused as
one nothing had said the type of.

A union of records is read as one record whose fields are every member's, the
ones only a member writes optional, and the reader keeps no literal text — so
the member a discriminant names is not a distinction it can make. `Extract` and
`Exclude` therefore read the whole of `T`: the wider of the two, which keeps
every field any member writes and reads the layout that writes it, and refuses a
field two members write at different types rather than guessing between them.

This took the total from 548 to 537.

### 4ci. The record a collection's element is

    for (const [index, fixup] of fixups.entries()) {
      this.fixups[index] = { ...fixup, at: fixup.at - bytes };
    }
    for (const [name, item] of items) total += item.at;

Two loops bind an element and then read its fields, and both were refused for
the same reason. A loop's binding is held at the *type* the collection spells,
and that type is the opaque reference a record of a declaration spells — the
fields are gone. The *shape* the declaration named is what the body reads, and
the loop did not keep it: `{ ...fixup }` was `an object spread reads a constant
object`, and `item.at` degraded to the reference itself.

A list's element is now read at the shape of the list's own, and a map's value
at the `valueShape` the collection already carried. Position 1 of
`list.entries()` and the value position of a map entry are bound to the record,
so the fields are read where they are written and a spread writes the other
fields through. `semantics/liveness.ts` and `semantics/power-of-two.ts` are now
read whole.

This took the total from 559 to 548.

### 4ch. The monotonic clock in whole nanoseconds

    const started = process.hrtime.bigint();
    const durationNs = process.hrtime.bigint() - started;

The runtime already read a monotonic clock, but in milliseconds as a double
(`blaze_rt_monotonic_ms`), and the source reads nanoseconds as a whole number.
A duration of a few microseconds is a whole number of nanoseconds and is lost by
a reading that keeps only milliseconds, so the milliseconds were not a reading
this could be computed from.

`process.hrtime.bigint()` is now a call of `blaze_rt_monotonic_ns`, an entry
that answers the same clock in whole nanoseconds. The frontend reads the call
where it reads `process.argv` — in a primary expression, before the member chain
asks whether `bigint` is a method of anything — and a builtin declares it as a
call of no arguments answering an `i64` with the `clock` effect, so the
optimizer does not compute it twice or hoist it out of a loop. The C, Nim and
wasm runtimes each implement the entry, and the wasm host answers
`process.hrtime.bigint()` itself.

This took the total from 566 to 559. The host object that was left is
`process.cwd()`, the directory a build runs in.

### 4cg. The error stream, and a write that does not end the line

    process.stdout.write(`\n${message}\n`);
    process.stderr.write(text);

A program body already wrote both streams: `process.stdout.write` was a print
that does not end the line, and the error stream was refused with the runtime's
own message. A *function* had neither — `process.stdout.write` was `"write" is
not a method this program compiles` — so the compiler's own modules, which
report progress from functions, could not be read.

A function writes the two streams the way the program body does. The output is
the print statement the IR already has, with the line not ended: `print_text`
and no `print_newline`. The error stream is a call of the runtime's entry for it
— `blaze_rt_print_error_text`, which flushes the output and writes to the error
stream — so the text a program wrote before it failed is still there when the
failure is read. The entry is declared with the rest of the ABI, and the C, Nim
and wasm hosts each write their own error stream.

This took the total from 574 to 566. What is left of the host is
`process.hrtime.bigint()`, which is a call of a clock the runtime carries as
milliseconds: a reading in nanoseconds is the next thing the queue names.

### 4cf. A field a conditional spread leaves out

    const one: Handle = { name: "a", ...(c ? {} : { tail }) };

The largest bucket the report had left was this form: a spread of a conditional
whose one arm writes a field and whose other writes nothing. The object the
source builds has the field *only when the condition holds*, and the value model
has no absent value — a field is at the zero of its type.

For a reference, that zero is the null reference, and the null reference *is*
what the language's `undefined` is: `one.tail === undefined` is the null test the
read already writes, and `one.tail ?? d` is the null coalesce it already lowers.
So the spread is the field written with `c ? tail : null`, and the object reads
it back the way the program wrote it. For a number, a text, a truth or a list the
zero is a value the program may have meant — `features: []` and `cpu: ""` are
both written — so those are refused rather than guessed; the absent value they
need is the item the spec still lists.

The layout needed one more read to match: `tail: c ? null : tail` was inferred as
a handle of no shape, because the description of the two arms differed, so the
field was a `double` and the C compiler refused to put a `Box*` in it. A choice
of a null and a *shaped* reference is the shaped reference.

This took the total from 580 to 574, and the spread bucket from 62 to 58.

### 4ce. A whole number of sixty-four bits, and `BigInt(x)`

    view.setBigUint64(where, BigInt(symbol.size), true);
    const headersAt = Number(view.getBigUint64(40, true));

The last of the ELF writer's byte operations are the sixty-four bit ones, and
two reads stood in front of them. `BigInt(x)` of a value the compiler does not
fold was a call of a function the program does not compile: the language's own
`Number(v)` is a builtin the runtime carries, and there was no `BigInt`. And a
store of eight bytes is a *whole* number's digits, which the double the value
model writes a number as cannot hold.

A number is a machine word, and the use converts it there — `convertibleTo` says
so — so `BigInt(x)` of a number is the value itself read at a `bigint`: the
number without its fraction, which is what the language's `BigInt` of a double
is. A value the compiler already holds is left to the read that folds it — a
literal is a constant, so `2n ** BigInt(128)` is still the wide constant a power
is folded with — and the digits a text states are left as the call the source
wrote. The eight-byte store is then the value's own shifts and
masks, and the load is the sum of the digits with the weights a bigint has: the
functions of the file that write and read two and four bytes write eight the
same way.

A bigint literal written in an expression came out as `256nLL` in C — the digits
with the `n` the language writes after them, and a suffix the C compiler does
not know — because the literal writer used the text the source wrote rather than
the value it names. `cLiteral` writes the digits now, which is the only spelling
C has.

This took the total from 602 to 580, and `toolchain/elf64.ts` from 31 refusals
to 9: what is left of it is `codePointAt` of a character, the two computed keys
of a record, and three calls of the read-back describer.

### 4cd. A view of a block

    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    view.setUint32(where, section.name, true);
    bytes.set(request.text, textOffset);

`toolchain/elf64.ts` writes the object file the machine backend links, and it
writes it as bytes. A typed array is a block the value model already has; a
view of one is the same bytes. So the view is the block — `bytes.buffer` is the
typed array itself, `byteOffset` is zero and `byteLength` is the length — and a
write of a chosen width is the stores that write it, from the least significant
byte up: `setUint16`, `setUint32` and `setUint8` each become a function of the
file that masks and shifts, and `getUint8`/`getUint16`/`getUint32` each become
the sum the bytes are. `bytes.set(source, at)` copies a list into the block.
Nothing new is asked of a backend: a helper is a function the file writes, and
calling one is a call.

A view of *part* of a block is refused: the block is the whole of what a store
reaches, so an offset or a length the stores are not checked against would be a
write past the view the source declared. `new DataView(buffer, 0, buffer.length)`
is the whole block and is read as it.

A field a class declares as `new Map<K, V>()` now holds that map: the type
arguments are part of the type the initialiser writes, so a key answers the
value it was declared to hold rather than `any`.

What is still blocked in the ELF writer is the sixty-four bit store and load:
`view.setBigUint64(where, BigInt(symbol.size), true)` needs `BigInt(x)` for a
value the compiler does not fold (it calls a function the program does not
compile) and a wide number written a byte at a time. The two are the next
blocker this file names.

This took the total from 609 to 602, and `toolchain/elf64.ts` from 39 refusals
to 31.

### 4cc. The shape a value has crosses the arm, and a body's own types

    function expandWalrus(module: PyModule): PyModule {
      type Expanded = { value: PyValue; pre: PyStatement[] };
      const expandExpr = (value: PyValue, scope: Set<string>): Expanded => { … };
      const S = value.start === null ? { value: null, pre: [] } : expandExpr(value.start, scope);
    }

Three reads kept `pre: []` from being a list of statements, and each is the
same question — *what shape does this value have* — asked where the answer was
already written down:

- **A type a body declares.** `type Expanded` is written inside a function, and
  the module's type table read only the declarations at the top of the file. The
  name was `any`, so the arrow's result had no shape. A function body is now
  read against a table layered over the module's (`TypeTable.parent`): the body
  sees the types it declares, and no other body sees them. The declarations are
  scanned before the body is read, so a body may name a type it writes below.
- **What an arrow answers.** An arrow's declared result is a *type* the contract
  can spell, and an interface is the opaque reference: the fields are not in it.
  The binding now keeps the shape beside the type, and a call of the arrow
  answers it.
- **The arm of a conditional.** `c ? { value, pre: [] } : expand(x)` was read arm
  by arm with nothing said, because the declaration states no type for it. An
  arm is now read at the type *and* the shape of the arm that has one — the same
  rule the reader already used for the arms of a `??` whose other side was a
  list, generalized from lists to records.

This took the total from 622 to 609, and `semantics/python.ts` from 20 refusals
to 16.

### 4cb. The type a call reads its arguments at

    const describe = (one: Input): string => one.label;
    describe({ label: "a", tags: [] });

An argument was read at the parameter's *contract type*, and the contract type
of an interface is the opaque reference: the fields are not a type the contract
can spell. So `{ label: "a", tags: [] }` was a literal of no shape, and the
empty list in it was `an empty array needs the type of its elements` — even
though the arrow states that `tags` is a `string[]`. Four call sites had the
same gap, and each now hands over both the type and the shape:

- a call of a function the module declares, where the signature is the one the
  file's own scan read (a parameter's annotation is resolved to a shape and
  carried beside the type it erases to; a wrapper for a shorter arity takes the
  shapes of the parameters it passes on);
- a call of a name bound to an arrow, where the arrow's own parameters say what
  the arguments are;
- a call of a method through its receiver, and of a static method;
- a constructor: `new Reader({ … })`.

The shape is resolved in the file that writes the declaration and crosses the
link for an exported one, exactly as the type does. Reading the argument at the
shape is not only what settles an empty list: it is what a call *means*, and
the literals are now checked field by field against the declaration they are
handed to.

This took the total from 680 to 622, and `semantics/typescript.ts` from 79
refusals to 26.

### 4ca. The type an exported constant offers

    export const SQLITE_ABI: readonly SqliteEntry[] = [
      sqliteEntry("blaze_sqlite_open", "double", …),
      …
    ];

A value built by calls is not a constant expression the file wrote out, so the
constant scan records only its field names and the link offers only the values
the file wrote. A module that imports the name then held a value of no type:
`SQLITE_ABI.map((entry) => entry.symbol)` was `"map" is not a method this
program compiles`, in `runtime/sqlite-build.ts`.

The annotation of an exported declaration is now offered beside the value, as
the *shape* it resolves to rather than the tokens that write it — the tokens
are another file's, and the shape is what crosses. A file that imports the name
reads it at that shape when no declaration of its own shadows it: a list of
records is a list whose elements `map` walks and whose fields a member chain
reads.

The shape is resolved in the file that writes the declaration, against the
table that file ended its read with. An annotation that names a type from yet
another module — a chain of imports — is read as the opaque reference in that
read, and the shape it would have named does not cross; no source of the
compiler offers one.

This took the total from 689 to 680, and `runtime/nim.ts` reads whole.

### 4bz. A default read at the parameter's type, and a collection in an entry

    method(types: ModuleTypeBinding[] = [], renames: ModuleTypeBinding[] = []): …

`TypeScriptParser` is a class, and every method of it wrote defaults like these.
The wrapper a shorter arity calls fills a default where the call was made, and
it read the tokens of the default with nothing said about what they hold: `[]`
was an empty list of no element type, and the read refused it. A free
function's own declaration already read the default at the parameter's
annotation; the class path now does the same, at the type *and* the shape the
annotation writes.

A set or a map held in a dictionary is one handle, and the entry holds it as
the number it is. The read of `get` — and of an index — answered the number and
nothing else, so `internal[to].has(name)` asked a `has` of a number. What a key
answers is now the collection the value's shape names, which is what the
questions written after it are asked of.

This took the total from 698 to 689.

### 4by. The type a top-level declaration writes

    export const RUNTIME_ABI: readonly RuntimeEntry[] = [
      entry("blaze_rt_initialize", "void", [], …),
      …
    ];

The value is a list of calls, so it is not a constant expression the file wrote
out: the constant scan records the field names it can see and nothing else. A
function that reads the name then held a value of no type, so
`RUNTIME_ABI.map((item) => …)` was `"map" is not a method this program
compiles`, even though the declaration states both the list and its element.

A top-level declaration's annotation is now kept with the names the scan
records, and a read of the name takes the shape the annotation writes when it
has no better answer. A list named as the element's type is a list `map`,
`filter` and `forEach` walk; a record is one whose fields a member chain reads.
The annotation is kept as the token range rather than a resolved type, because
the table it resolves against is the one the module graph builds: a read with
imports bound resolves it against the linked table. A name a body declares is
the body's own, so the annotation only answers where no declaration shadows it.

Two reads were wrong in the same place and are fixed with it. The keyword table
is asked for its own keys, because every object inherits `constructor` and
`toString`: a statement that wrote `constructor.internal = false` was refused
as the keyword `constructor`. And a spread only copies the fields of a record;
a dictionary has none, and copying "no fields" wrote an empty object where
every entry had been lost.

A boolean written out is a constant, so a table of truths —
`const HARNESS_RESERVED: Record<string, true> = { … }` — is a value the file
wrote, and a spread of one copies its entries.

This took the total from 725 to 698, and `core/target.ts`,
`toolchain/linker.ts` and the six runtime ABI files read whole.

### 4bx. A closure a layout field holds

    interface Sink { write(text: string): void }

    function greet(sink: Sink): void {
      sink.write("hello");
    }

`Sink.write` is a field whose type is a function, not a class method. Two reads
stood between it and the IR. The frontend asked for a method of a class the
file carries, found none, and refused — a call through a value the declaration
types as a function was outside the subset. And the layout pass, for a literal
written in a *program's* statements, laid a value it had no simpler answer for
out as the widest number a field can hold: `{ write: (t) => … }` became an
object with one `u256` field, and calling one was `Object1.write is a u256, not
a void` even after the call was read.

The call is now the invocation it is: a member whose shape is a function is
read against the parameters and result the declaration writes, and lowered as
`invoke` with the field as the value it is called through. A function type
states its parameters — `(text: string) => void` — which is what an argument is
read at. The program pass reads an arrow as the reference to the code it names,
which is what a function-typed field holds.

`toolchain/program-emit.ts` goes from 95 refusals to 12, and the value-model
item the queue was waiting on closes for every arrow written in a function body:
the C backend already builds and calls the closure that arrow becomes, and so
does the machine backend once the pass specializes the call. What is still not
carried is an arrow written directly in a *program's* statements and stored in a
field: that value is a bare code address (`functionRef`), the backends pass one
to a callback site by name and do not store it, so such a program is read and
laid out and then fails to link. No source of the compiler writes one.

This took the total from 847 to 725.

### 4bw. A module that re-exports

`core/platform.ts` is the host boundary, and it declares nothing: it is one
list of names another module writes.

    export { readFile, readdir, join, ... } from "./platform-node.ts";

The reader refused a re-export, so the boundary itself was outside the subset,
and every file that imported from it read those calls as `any`. A re-export is
now read as the offer it is: the frontend records the module and the names
(`ModuleAnalysis.reexports`), the graph resolves that module like any import,
and a file that names one of the names is given the signature the module that
declared the function wrote. A module that only re-exports is a library the
contract phase accepts, and the call a build emits is the one the declaring
module compiled.

This took the total from 857 to 847, and `core/platform.ts`,
`runtime/model-build.ts`, `runtime/sglang-build.ts` and
`runtime/triton-build.ts` read whole. A re-export written under another name —
`export { a as b } from "./x.ts"` — is not read: the names are the ones the
source writes unchanged, and no source of the compiler renames one.

### 4bv. The type a method writes for its result

    make(): { name: string; size: number } {
      return { name: "x", size: 1 };
    }

The class scanner read a member's return type as one leading name, and an
object type is not a name: the result became `any`. The brace that opens the
body is already found from the type's shape (§4bh), so what is written between
the `:` and that brace is the type — in every form the source writes one, not
only a name. The same read fixes a union of object types, a parenthesised union
and a generic with an object argument, which were `any` for the same reason.

What a call *answers* then needed the second half. `factory.make()` recorded
the contract's spelling of the result, which for a record is the opaque
reference, and nothing recorded the fields. `typedCall` now keeps the shape the
declaration named beside the type, which is what `{ ...made }` copies and what
`made.size` reads.

This took the total from 903 to 857.

### 4bu. A field a modifier is written in front of

    export type RepairOutcome =
      | { readonly applied: SemanticFunction; readonly note: string }
      | { readonly refused: string };

The union's members are object types written in the text of an annotation, and
the reader of that text took the first name of each member as the field's: it
saw a field named `readonly` whose text after it was `applied: …`, which is not
an annotation, and moved on. Every member of every such object type was empty.
The type still resolved — a union of records with no fields — so
`"applied" in outcome` asked a value whose fields the type did not write down,
`outcome.applied` was a field of nothing, and a spread of one copied nothing.

An interface is read from the tokens, where `readonly` was already skipped; the
text of *inline* object types is where the modifier was missing. It is now read
as the modifier it is — `readonly`, `public`, `private`, `protected`,
`override` — and a field whose name happens to be one of those words
(`{ readonly: boolean }`) is still the field it names.

This took the total from 916 to 903, and `semantics/restructure.ts` goes from
five refusals to one: its `if (!("applied" in outcome))` is the union's tag
chain, which is the question the language asks.

### 4bt. A signature a refused module still offers

`restructureHotFunction` answers either a function or the reason it could not,
and its caller writes `if ("refused" in restructured) return fn;`. The
declaration is a union of shapes in `semantics/repair.ts` — and that file is
refused, so the read that links `semantics/optimize-ir.ts` against it found no
declaration of `inlineCall` at all. An *exported* declaration whose body the
module refuses is dropped from the module's functions, and a caller then knows
nothing about what it answers.

The drop is right for the module: a build stops at the file it cannot read,
and a function it cannot hold is not compiled. What it must not drop is what
the declaration *says*. A signature with no body is already read as the
signature it is (§4ac); a file that names the function reads its calls against
the parameters and result the declaration wrote. The read now keeps those
signatures beside the functions (`ModuleAnalysis.signatures`), and the link
offers them to the files that import the name. A build's answer is unchanged —
the refusing file still stops it — and the measurement reads the caller
instead of stopping at the import.

This took the total from 945 to 916, and `toolchain/csource.ts` reads whole.

### 4bs. What a collection's value holds

The compiler walks a `Map<string, Item>` in its own functions:

    for (const item of table.values()) out += item.names.join(",");

What `values()` answers is a block of the map's value type, and a collection's
*type* can spell only the opaque reference: the fields a declaration writes are
the shape's, not the type's. The block therefore held unnamed references, the
loop bound `item` to one of them, and `item.names` was a field read through a
reference that named nothing — `join` written on it was a method of nothing.
`Object.values(record)` and `map.get(k)` were the same.

A collection now keeps the shape its value was written at beside the type.
`CollectionValue.valueShape` is the record the annotation named; `values()`,
`keys()` and `get()` record it on the answer they build, and `for..of` binds
the element at it. `get` already carried the shape of a value whose *source*
named a declaration (that was the `?.` slice); the path an annotation takes —
`annotationCollection` — built the collection from the type text alone and
dropped it.

This took the total from 991 to 945, and `semantics/calls.ts` and
`semantics/parallel.ts` read whole. The object-spread bucket rises by five:
a spread whose value the read can now type is read, and what it reaches behind
the deferral is another gap.

### 4br. A class another module declares

The largest file of the tree was also the largest queue: 859 of the 2218
refusals were in `toolchain/ir-machine.ts`, and almost all of them were one
shape.

    this.code.movRegReg(RAX, register);

`code` is `readonly code = new Encoder()`, and `Encoder` is a class of
`toolchain/x86.ts`. A class is lowered to functions of the module that declares
it, and the class table was that module's alone, so another file had no way to
know what an instance answers. The first read deferred — the field's type names
an import — and the read that followed the link refused every method:
`"movRegReg" is not a method this program compiles`.

A class now crosses the link as the description of itself.
`bindImportedClasses` copies the declaring module's `ClassInfo` into the
importing file's class table under the name that file reads it by: the fields,
the methods and getters, the statics, and the arity of each. The bodies stay
with the module that wrote them, and every token position in the copy is `-1`,
because an index into another file's tokens means nothing here; the `ordered`
list, which is what emits declarations and cuts them out of the text, is still
the local one, so nothing is emitted twice.

The call the importer writes names the same function the declaring module
compiled (`Encoder_movRegReg`), which is how the rest of the link already
works: one table of functions, keyed by name. A class imported under another
name keeps the declaring module's name for exactly that reason, and a class a
module offers as its *default* is not bound, because the import statement does
not say which name the file reads it under and no source of the compiler
imports a class that way.

`toolchain/ir-machine.ts` goes from 859 refusals to 61 and the total from 1841
to 991.

**A finding under it, not fixed.** `semantics/builtins.ts` now reads whole but
offers no functions at all, so every call of `builtinFor` in the tree answers
`any` — `builtin.params.map(...)` is one of the queues this slice did not
reach. The file's `BUILTINS` is a table of four hundred entries whose values
are computed objects, so the scan calls it *state* rather than a constant, and
a function that reads state is read where the program runs. An exported
function cannot be a program function, so the declaration is dropped from the
library's functions and no refusal is written — the file looks read and offers
nothing. It is the module-scoped global the roadmap names, and the slice that
carries one will make this file's functions real.

### 4bq. An expansion of a type is made once

Making the union below a real record made the frontend expand it, and a
declaration such as the IR's `SemanticValue` names a field of nearly every type
the program has: expanding it parses sixteen hundred characters of type text.
A member read asks for the same declaration again for every value it sees, and
the linked read of the compiler's own tree made 5.8 million such calls, 129
million characters: `semantics/ir-validate.ts` alone took 95 seconds and the
whole tree five minutes.

An expansion depends on nothing but the declaration and the table it is written
in, so `instantiate` keeps the one a table made from the top of a type. An
expansion made *inside* another one is not kept, because it reads the names its
parent already opened as references and that cut is part of the answer. The cut
is the same for every expansion that starts at the declaration, so the kept one
is what every top-level ask would have built.

The table is not constant: a module is read once before its imports are bound
and again after, and a declaration read before the link names the imported type
it writes as `any`. Keeping that expansion would hide the declaration the link
brought in — a local `interface Wrapper { holder: Holder }` would still hold
`any` after `Holder` was bound — so `bindImportedTypes` bumps a generation and
an expansion from before the link is not read after it. The tree is 13 seconds
again.

The total moved by two, and in the direction that means work: a nested expansion
cut at a reference leaves a field `any`, and the eager one lets the loop or the
spread written through it be read — and both of them report the gap that was
standing behind the cut (`Object.values(file.functions)` in
`semantics/ir-validate.ts`, an empty list in a field of `loop.reductions`).

### 4bp. A union laid out with a leading bar

The sources lay a union out one member per line and write the bar before the
first member:

    export type SemanticValue =
      /** A number written out, of the type it is used at. */
      | { k: "const"; type: SemanticType; text: string }
      | { k: "text"; type: TextType; parts: SemanticTextPart[] }
      | ...;

The type reader read that bar as the start of a member. The member it started
was `any`, and a union is the member its values can hold only when every member
is a record: a union whose first member is `any` therefore *is* `any`. Every
declaration the sources lay out this way erased, and every member read through
one was a method of nothing — `value.call.args`, `statement.then.statements`,
`contract.files`, and the fifty-five `{ ...value, left: next() }` spreads of a
`SemanticValue` in `semantics/optimize-ir.ts` and its neighbours.

The bar states no member and is now skipped where a type begins. This took the
total from 2218 to 1839, and `core/semantic-ir.ts` and `runtime/http-needs.ts`
read whole.

The earlier report of this bug (§ "A finding, not a slice") said fixing it
lowers the frontend's own count by five and *raises* `semantics/python.ts` by
twenty-two, because the types it erased are the ones whose lists are walked
with `flatMap`. That was the standalone read. The linked read resolves the
declarations the erased types named, so the same fix is worth 379 refusals
across the tree, and `semantics/python.ts` falls rather than rises.

### 4bo. A declared function is a value a collection method takes

`feedback.map(asBullet)` and `declared.map(stringLiteral)` hand a collection
method a function the file declares. The method's callback was an arrow, or a
name held at a function type; a declaration was not, and five of the compiler's
own refusals were that form: three in `ai/review.ts` and two in
`semantics/ir-text.ts`.

A declaration is a value where it is not called. The name is read as the
closure it is: nothing is captured, and the entry is a function of the file
that takes the closure the call hands over and calls the declaration with the
arguments the closure does not use. The entry's name is the declaration's,
prefixed with the file's stem, so a declaration called `twice` is entered
through `__closure_code_<stem>_twice` and the declaration itself is still the
one function of that name. A name the body declared itself is the value of
that body, and a number passed where a callback is expected is still refused.

The signature a call through the closure is written against is the
declaration's, so `values.map(withIndex)` passes the element and the position,
and `values.filter(even)` passes the element and reads the truth the
declaration answers. The entry is the one an arrow's closure already uses; the
C backend carries it, and the machine backend, which cannot lower a closure,
falls back to C as it does for an arrow value. A closure whose `code` is
already set is left alone where a value is read, so the entry is written once.

This took the total from 426 to 421.

### 4bn. A collection written clear is a new, empty dictionary

`m.clear()` and `s.clear()` were read as a method no class declares, because a
collection's methods are the runtime dictionary's and the dictionary has no call
that empties one in place. A collection here is a handle a name or a field
holds, and the clear is the write of a new, empty dictionary over that handle:
`m.clear();` is `m = new Map();`, which is the statement the call is written as.
The receiver is named by the marker `__collection_clear`, and `readEffect`
writes the place with `blaze_rt_dict_new`. Only a statement reads it, which is
where the source writes it: a clear used as a value has no lowering.

This took the total from 428 to 426: `semantics/objects.ts` no longer refuses
`this.registered.clear()`, and `semantics/typescript.ts` no longer refuses the
two `this.unsettledArrays.clear()`.

### 4bm. An arrow's concise body may be the assignment it writes

`const backend = (): AiBackend => (backend ??= backendOf());` — `codegen.ts`
writes it — is an arrow whose concise body is a whole assignment. A concise body
is read as an expression, and an assignment is a statement here, so the reader
stopped at `??=` with `expected ")"`.

A concise body is the return the source wrote without the word, and an
assignment written as a whole value is the write and the value it wrote: the
body is the statement, and what it answers is the name. The parenthesised form
is the same value and the parentheses are the writer's, so both are read. The
parentheses are only read as this shape where they close at the end of the body,
so a value that merely starts with an assignment — a call's first argument — is
still read as the source wrote it. `??=` keeps its short circuit: it lowers to
`x = x ?? value`, so the value is not computed where `x` holds one.

This took the total from 429 to 428.

### 4bl. A value pushed into a list is read at the element it holds

`list.push(value)` reads every value at no type at all, so a value that states
nothing — `this.scopes.push([])` — was an empty list with no element. The list
being pushed into does say what an element is, and the value written is one: the
argument is now read at the list's element type, so `rows.push([])` is an empty
list of texts when `rows` is a list of lists of texts, and an object written
there is read at the element's shape. `unshift` writes the same way. The change
is a fourth argument to `readCallArguments`, `rest`, for the type of every
argument the call does not state positionally.

This took the total from 430 to 429; `toolchain/names.ts` no longer refuses the
empty list a scope is opened with, though its next construct — a push through an
index — is a separate gap.

### 4bk. hasOwnProperty over an object the file wrote is its names

`Object.prototype.hasOwnProperty.call(record, key)` was read for a record
keyed by text — the runtime's dictionary — and for nothing else. The compiler
asks it of its own tables: `BUILTINS`, `ENV_KEYS`, `NIM_PRIMITIVES`, each an
object literal the file wrote. An object literal is one layout, not a
dictionary, but the question about it is still one the source answers: its
fields are the names the source wrote, so a key is one of them when it is equal
to one of those names. The comparison chain is read with the key held once.

The names are recorded even when the values are computed. `ENV_KEYS` is a
`Record<ProviderName, readonly string[]>` whose values are not constants, so
the object is a value the program holds; its *names* are still written down,
and the scan records them beside the state it already records. A name the file
writes to is not recorded: a write could add a key the source never named.

This took the total from 433 to 430, and `ai/model.ts`,
`semantics/builtins.ts` and `semantics/frontend.ts` are read whole.

### 4bj. A collection allocation may end its arguments with a comma

A `new Set(source)` reads one source expression and then the `)`, and the
sources write the argument list over several lines with a comma at the end of
the last one — the compiler's own `new Set<string>(\n  bodies.filter(...).map(...),\n)`
is that shape. The comma is not a second argument and no set holds it: the
allocation accepts it where it accepts the `)`, and the list of pairs a `new
Map([...])` is built from does the same.

This took the total from 437 to 433: two in `compiler.ts`, one in
`semantics/program.ts` and one in `toolchain/assembler.ts`.

### 4bi. An object type inside a type argument is part of the type

`Map<string, { register: number; established: boolean }>` is one return type.
`toolchain/ir-machine.ts` writes it for `cacheTurnReads`, and the class scanner
saw the `{` inside the angle group as the method body. The angle group a return
type writes is now skipped as a type: its own `<`/`>` count, and the object,
parenthesised and tuple groups inside it are skipped whole, so the `>` that
closes the type is the one that ends it. A comparison is not a type, and is not
read here: the `<` of a return type is always a type argument.

This took the total from 441 to 437: four in `toolchain/ir-machine.ts`, whose
members the desync had hidden.

### 4bh. A method's result may be a union of object types

The class scanner found a method's body by skipping to the first `{` after the
return type. A result written as an object type starts with the same brace, so
the scanner had a special case for it; a *union* of object types had a second
brace after the first, and the second arm was read as the body. An `is`
predicate had the same shape: `value is SemanticValue & { k: "call" }` put the
object after an `&`, and its brace became the body. The members after it were
read from inside a type, and `semantics/ir-resolve.ts`'s `equality` (three arms
of object types) and `toolchain/ir-machine.ts`'s predicates refused at `:`.

A brace is part of a type when the token before it says the type goes on: the
`:` after the parameter list, a union's `|`, an intersection's `&`, the `is` of
a predicate, a `keyof`, a type argument's `<`, a comma or an arrow. Any other
brace is the body, and a `;` at the top is a member with no body. The scanner
skips the type as a whole — its brackets, angle groups and object braces — and
lands on the body.

This took the total from 442 to 441: three in `semantics/ir-resolve.ts` and one
in `toolchain/ir-machine.ts`. The refusals the desync had hidden behind them are
now read, which is why the drop is smaller than the sites.

### 4bg. A method named length is a call, not a length

`x.length` is the length of the sequence a name holds, and the frontend read
every `.length` that way. A class that declares a method named `length` was
therefore read as a call of a number: `this.length(value.of, depth)` became "only
a named function is called" and the three emitters that walk a value with a
method of their own (`toolchain/ir-c.ts`, `toolchain/ir-machine.ts`,
`toolchain/program-emit.ts`) refused at it.

The length is read only when no `(` follows the name. A call is the method the
class declares, and the program reader, which has the same special case, makes
the same distinction.

This took the total from 443 to 442, and `toolchain/ir-c.ts` is read whole.

### 4bf. An import is hoisted from wherever it is written

An import binds a module's names for the whole file, so it is read where it is
written rather than only before the first declaration. The frontend required
every import to come first, and `semantics/ir-function.ts` writes a constant,
then two `import type`s and a value import — so the file was read as a program
whose first statement was `import`, which a program cannot run, and the whole
body was read by the wrong parser. Reading the import as the import it is makes
the file a module again, and the refusals the program parser reported inside it
are gone with it.

The spans of the imports are still held out of the body the program parser
reads, and they are held out wherever they are written: an entry module that
writes a constant, then an import, then a statement runs the constant and the
statement, and the import binds the module for both.

This took the total from 448 to 443: five in `semantics/ir-function.ts`, whose
program read had hidden what the module holds.

### 4be. A default parameter in a program function

A module function with a default parameter is callable at every shorter arity:
`defaultWrappers` writes one function per arity, each filling the defaults the
source wrote and calling the full one. A *program* function was not: its
parameter list stopped at the type, so `function optionNumber(value: string |
undefined, name: string, minimum = 1, maximum?: number)` refused at the `=`, and
that is the first function of `cli.ts` the report stopped at.

The program now reads a parameter's `?` and its `=` and keeps the default as a
value. `ir-resolve` writes the same wrappers the module does, as program
statements: the shorter arity declares each default where the call is made,
under a name of its own, and calls the full function with it. The default is
read once, before the call, so a default that is itself a call runs before the
arguments are pinned in the registers it uses — the same rule the module states.
A call of a shorter arity finds the wrapper by the name the module uses,
`f__1`, so nothing about the call site changes.

The `?` states nothing a program can hold yet: a program has no absent value of
its own, so the parameter is the type it was declared and a call that omits it
is still refused at the arity. That is the same reading the module frontend
gives it today (it erases the `?` too), and it is what keeps `cli.ts` from
reading all the way: `maximum?: number` needs the absent value, not a default.

This took the total from 449 to 448. The one refusal is `cli.ts`'s parameter
list; the defaults it contains are now what a shorter call fills.

### 4bd. A for loop that is not a counted loop

The frontend read `for` two ways: a counted loop whose condition compares the
index with a bound, and `for (const x of xs)`. Everything else was refused with
"the loop condition must compare the index with a bound", and `semantics/ir-text.ts`
writes eight loops the third way:

```ts
for (let line = this.peek(); line !== null && line.indent === 0; line = this.peek()) {
```

That is a while loop with an initialiser and a step. It is read as one: the
initialiser is a statement before the loop, the condition is the while loop's
condition — read every turn — and the step is the last statement of the body. A
`continue` of that loop runs the step, so the step is also written in front of
every `continue` the body's own loops do not hold, which is where the source put
it; a `continue` of a loop the body holds belongs to that loop and is left alone.

This took the total from 465 to 449: eight in `semantics/ir-text.ts`, and the
rest are the loops in the compiler's own reader whose bodies the refusal had
hidden.

### 4bc. new Array is the array of numbers, and fill writes it

`new Array(n)` is the array of numbers the source language has, and the compiler
read it as a construct it did not know: the name was not one of the typed arrays,
so the allocation was refused. It is the block of `n` cleared elements a typed
array of numbers is, and `new Array(a, b)` names its elements instead.

`a.fill(v)` is not a callback method — the value is written into each element
rather than read out of one — so it was read as a `map` whose callback was the
value and refused. It is a function of the file that walks the list and writes
the value into every element, which is a statement and the list itself.

Together they are the field `new Array(universe).fill(-1)` that a sparse set is
made of. This took the total from 476 to 465: eight in `util/sets.ts`, two in
`toolchain/probe.ts` and one in `semantics/optimize-ir.ts`.

### 4bb. A switch, a list written at a length, and a program's own output

Three things the entry of the compiler writes that the program reader did not
know, and they are one slice because the first two hid the third.

**A `switch`** is the chain of comparisons its cases are: the subject is read
once into a name of the switch's own, and each arm is an `if` that compares the
name with the case. An arm that does not end by leaving the switch runs into the
arm after it, which is the language's fallthrough; a `break` at the end of an
arm is the arm leaving the switch and is dropped with the end of that body. A
`break` anywhere else in an arm leaves the switch from inside a nested statement,
which the chain cannot say, and that is refused rather than read as a break of
whatever loop the switch is in.

**`a.length = n`** is the list at that length: the first `n` elements, and the
empty elements a longer list gains after them. A list is a block whose length the
runtime keeps in a header, so the write is a block of its own rather than a size
written into the one it had — which is a copy where a write of the header would
be none. Every use of a length in the compiler's own sources is a rollback of a
list to a mark it had, so the copy is the list it keeps rather than the one it
drops.

**`process.stdout.write(text)`** writes the text where it is and does not end the
line a `console.log` ends. A program has no way to write to the error stream —
that is the runtime's own — and `process.stderr.write` keeps the refusal it had.

The switch is why the first two are one slice: reading the arms of the entry's
switch uncovered the writes the refusal had hidden, so the slice that reads a
switch has to read what its arms write as well.

This took the total from 483 to 476: `toolchain/ir-machine.ts` loses its six
rollbacks, `dump-ir.ts` and `semantics/typescript.ts` their writes, and the
entry's own two error-stream writes are what is left of its switch.

### 4ba. splice is a range replaced by the values written

`xs.splice(at, del, ...items)` was not a method of this compiler, and the five
sites that write it are how the compiler rebuilds a list in place: the refusals
of a round, the statements of a block, the functions a program keeps. The answer
is the range the call took out, read before the write, and the list the name
holds afterwards is the part before the range, the values written, and the part
after it — which is the concatenation of two lists with a list of the values
between them.

The positions are the ones the language uses: a start below zero counts from the
end, a start past the end is the end, and a count below zero takes nothing out.
Each position is read once into a name of the statement's own, because a
position is written three times and a call read three times runs three times.

This took the total from 494 to 483: the five sites and the spreads written
around them, which were refused as a spread argument before the call was read.

### 4az. shift and unshift are the two ends of a list

`xs.shift()` and `xs.unshift(v)` were not methods of this compiler: nine
refusals, the queue the code generator waits its work in and the pending
statements the frontend keeps among them. Both change the list a name holds, so
the change is written beside the statement the call was read in and the value is
read before it: a shift answers the element it took out, which is read into a
name of the statement's own, and an unshift answers the length the list has
afterwards. A call written for what it does writes the change and drops the
answer, which is what the statement reader already did with a push.

The shift is the list from one past its first element on, which is the slice
helper a `list.slice(1)` already is; an unshift is the values written in front of
the list, which is the concatenation of two lists.

This took the total from 503 to 494.

### 4ay. flatMap is the lists its callback answers

`xs.flatMap(f)` was not a method of this compiler. The callback answers a list,
and the answer is those lists one after another: a list of lists is not a value
here, so each answer is walked where it is read and its elements are appended to
the answer of the helper. A callback that answers one value appends that value,
which is what the language's `flatMap` does with one.

`map` keeps its refusal of a list answer: a `map` of a list is a list of lists,
which is a different value from the concatenation.

This took the total from 514 to 503, and `toolchain/csource.ts` reads whole.

### 4ax. A captured list, held in a one-field object

A name an arrow writes is held in a one-element list (§4al), but a list has no
element that holds a list: `found.push(n)` inside an arrow was still refused,
and that was the largest real bucket — 78 refusals, in `pres`, `found`, `names`
and the other accumulators the compiler's own functions declare outside an
arrow and append inside it.

What a list needs is a box that holds one **field**: the name becomes a one-field
object, the arrow is handed the object, and both sides read and write
`box.__boxed`. Two things had to be true first.

**A list field is a slice** (§ "A list field is one field whatever the literal
held"). A field initialised from `[]` was typed `array<T, 0>`, so the first read
past the empty length was a read past the block, and two literals of one
interface were two layouts. A field written from a list is a `slice<T>` now: the
block carries its length, and the field is a pointer to it.

**A loop that appends keeps its storage.** `push` answers a longer list, and the
`__collect` helper that answers it builds a block. `calleeBuilds` counted an
object a callee builds and not an array, so a loop whose body appends kept the
region mark and the next turn's rewind wrote over the element the turn before had
appended: `out.push(x)` in a loop dropped the first element. That is fixed here
too, and it was a wrong build on its own, without any arrow.

The box is made where the name is declared, from the value the source wrote. An
arrow lifted before the box existed — another arrow had already captured the
name — has its body and its parameter rewritten when the box is made, so an
arrow that only reads the list is handed the object as well.

This took the total from 588 to 514, and four more sources read whole
(`core/semantic-ir.ts`, `runtime/nim.ts`, `semantics/parallel.ts`,
`semantics/power-of-two.ts`).

### 4aw. A top-level list asserted as const, or joined

The scan of a file's top-level constants stopped at the closing `]` of a list
literal, so what the source wrote after it was read as the next statement:
`export const SPINNER_FRAMES = [...] as const` was the assertion read as a class
member's value, and `export const cSourceRules = [...].join("\n")` was the call
read as the body of nothing. Both are the same initialiser as the list, and the
scan now follows the `as`/`satisfies` and the calls written after the literal.

A value a call answers is not a value the scan can write down, so the name is
state rather than a constant. That is enough for the scan to read the file: it
is the *misreading* of the suffix that was refused, not the value.

This took the total from 591 to 588: two in `core/terminal-title.ts` and one in
`toolchain/csource.ts`.

### 4av. A destructured rest element

`const [head, ...rest] = value` is the first line of four functions in the
compiler's own sources — the bullet writer of a diagnostic, the rule reader of a
proposal, the mnemonic reader of an assembly line and the vector reader of the
machine backend. The rest element was not part of the destructuring subset.

The rest is the list from its position to the end: the elements before it are
read by position, as they were, and the rest is the slice of the value that
starts there. A written-out list gives the values left as a literal; anything
else is the sequence's own `slice`, which is the helper a `list.slice(n)` is.

This took the total from 595 to 591: one in `ai/review.ts`, two in
`core/proposal.ts` and one in `toolchain/ir-machine.ts`.

### 4au. A value marked with void

`void compilerDir;` is a statement the three model-build programs write to say
they read a value they have no use for. The statement has no effect, and both
readers now read it: the program reader drops it, and the module reader keeps the
read as a statement of the body — a value it holds for nothing is a value the
optimizer removes.

This took the total from 598 to 595, one in each of the three build programs.

### 4at. An arrow that only reads a boxed name

A name an arrow writes is held in a one-element list (§4al), and the arrow is
handed the list. An arrow that only *reads* the name read the name itself — and
the declaration had become the list, so the name was gone: the read was of a name
nothing declares. The capture is now mapped to the box whether or not the body
writes it, and an arrow lifted before the box existed has its body and its
parameter rewritten when the box is made: `const read = () => total` after
`const add = (n) => { total += n }` is handed the list the addition writes.

This costs no refusals. It is a wrong build the measured sources do not happen to
contain — the pattern needs one arrow that writes a name and another that only
reads it, in the same function — and the test that finds it is in
`test/language-features.test.ts`.

### 4as. A field written through a reference the ABI carries

A wrong build, found while looking at what a box for a list would be. A
reference travels between functions as the double the ABI carries it in, and a
layout's field is reached through a pointer. The store into a field cast the
double straight to a pointer — `((struct Object1*)inner)->list` — which C
refuses to compile: *cannot convert to a pointer type*. The read of the field
already cast through `uintptr_t`, and the store now does too.

So a program could not pass an object to a function and write one of its fields,
which is the shape every record of this compiler is built with. `OB5` below is
the smallest form of it: an interface with a list and a count, a function that
pushes to the list and counts, and a caller that hands the object over.

This costs no refusals — the C backend refused the *candidate*, which the
frontend had read — and it is the thing that stood in the way of a box for a
list.

### 4ar. A text searched from a position

`text.indexOf(needle, from)` is the two-argument form, and the frontend read
only the one-argument form: `source.indexOf("\n", column)` is how the Python
frontend, the TypeScript frontend and the assembly reader all find the end of a
line, and each was refused.

The runtime's search starts at the beginning of the text, so the search from
`from` is the search of the field that starts there, and a hit is that field's
position plus `from`. The start is clamped the way the language clamps it: below
zero is the beginning, past the end is the end.

This took the total from 601 to 598: two in `semantics/python.ts` and one in
`toolchain/asm-text.ts`.

### 4aq. A text repeated

`text.repeat(n)` was not a method of this compiler, and the text formatter writes
it eight times for an indent and a separator. It is now a function of the file
that appends the text to an answer of its own `n` times — the same shape the
split helper is — with the count floored, as the language floors it: a count of
`2.7` repeats twice, and a count below one repeats nothing.

The helper appends rather than allocates once, so a large count is quadratic in
the length of the answer. Every use in the compiler's own sources is an indent
of a few characters; a repeat of a long text that many times is the one shape
this does not read well.

This took the total from 608 to 601: five in `semantics/ir-text.ts`, one in
`toolchain/ir-c.ts` and one in `toolchain/program-emit.ts`.

### 4ap. An arrow takes the rest of a call's arguments

`(...taken: string[]) => ...` is a parameter list the arrow reader did not know:
it read the `...` as the name of a parameter and answered that a parameter name
was expected. Twelve of the compiler's own refusals were that form, and the two
in `toolchain/c-names.ts` are how the whole of `cHeaderNames` is written — the
file's name table is taken a line at a time.

The rest parameter is a list, which is what the lifted function takes as one
parameter, and a call packs what it wrote from that position on into a list
literal of the element type the annotation states. Every call in the file is a
call by name, so the packing is written where the arguments are, and the list is
the one the arrow's body walks.

This took the total from 610 to 608. The rest of the `expected a parameter name`
bucket is not this form: `semantics/python.ts` and `semantics/typescript.ts`
still answer it for constructs of their own.

### 4ao. An optional chain reads the value once

`f()?.field` reads `f()` in the guard and again inside the branch, so a chain
whose value before `?.` is not repeatable was refused — ten of them, in the
compiler's own sources. The value is now written into a name of the statement's
own before the statement, exactly as `a.b.c = d` already wrote its owner, and
both reads are the name: the call runs once, which is what the source wrote.

The one place a name before the statement would change the answer is a loop
condition, which is read every turn rather than once. The while and do-while
conditions are read with a flag set, and a chain there keeps the refusal. A
counted `for` loop already treats its bound as a value computed once, so a chain
in a bound is hoisted like any other.

This took the total from 618 to 610, and `runtime/standalone.ts` reads whole.

### 4an. Two calls written the same way are two calls

A wrong answer, found while testing the slice below. `inlineCall` inlines every
call a block makes to a callee, one call at a time, and each inline binds the
callee's result to a name of its own. The rewrite that put the name where the
call was, though, replaced *every* value equal to the call — and two calls
written the same way are equal values. So `${c.next()}-${c.next()}` inlined one
body, bound one result, and answered it twice: the callee ran once where the
source ran it twice, and `n1 n1` was printed for `n1 n2`.

`replaceValues` now takes a flag that stops after the first replacement, and the
inliner asks for it: the calls are written in order, so the leftmost remaining
one is the call the block was read as making.

**One wrong answer remains, and predates this.** A call written as a statement
of its own — `c.next();` with its result unused — is refused by the inliner,
which is right; but when the calls around it are inlined their bodies are
written where the statements are, and the refused call keeps a position the
source gave it only relative to those statements. In
`const a = c.next(); c.next(); const b = c.next();` the program prints `n2` for
`a`, which the source prints as `n1`: the middle call runs first. It is a
reordering of an effect across another effect, and it is the next thing to read
in the inliner. It is not caused by either of this session's changes: the same
program answered `n2 n2 2` before them.

### 4am. An assignment where an expression goes

`` `n${this.builds += 1}` `` is a write written where a value goes, and seventeen
of `toolchain/driver.ts`'s refusals were that one construct in the driver's own
name generator. The expression reader stopped at the `+=` and reported what
followed as a value nothing could follow.

A write is a statement, so the assignment is read as one: the place becomes the
value the expression answers, and the write is written in front of the statement
the expression is part of. The place is read after the write, so
`${this.builds += 1}` answers the number the write left there — `1` the first
time, not `0`.

The value is the place read after the write, which means the write runs before
the statement around it. For an expression whose other parts have effects the
order would differ from the language's; the compiler's own uses are all in a
declaration of the text, where there is nothing else to order against.

`toolchain/driver.ts` now reads whole — every 33 of its refusals were this
construct or the cascade it left — and the total went from 651 to 618.

### 4al. A captured value written by an arrow

An arrow is lifted into a function of the file, and the values it captures are
handed to it as leading parameters. A parameter carries a value in, so a write
the arrow's body makes reached the lifted function's own copy and vanished:
`let total = 0; const add = (v) => { total += v; }; add(2);` answered `0`. The
frontend refused the construct rather than compile the wrong answer, and the
compiler's own sources write 152 of them.

A name the arrow writes is now held in a **one-element list**, which is a
reference, and the list is what the arrow captures. Both sides read and write
the element: the declaration `let total = 0` becomes `const total = [0]`, the
body writes `total[0] += v`, and every read of `total` in the function around
the arrow is the element. The list lives in the function around the arrow, so
it outlives the lifted call exactly as the name did, and an arrow that escapes
as a value carries the same list in its closure.

The boxing is done after the arrow's body is read, because whether a name is
written is only known then. The nearest body that declares the name is the one
that holds the list: a name declared inside an enclosing arrow is boxed there,
a name declared by the function is boxed there, and a parameter is boxed where
the body starts. A name no enclosing body declares is still refused.

Two forms are not held this way, and keep the refusal they always answered: a
**list**, because a list has no element that holds a list (`found.push(x)` in an
arrow is the list-of-lists item below), and an `x++` **read as a value**, which
is not a write to an element.

This took the total from 725 to 651, and one source — `semantics/region.ts` —
now reads whole. What is left of the arrow writes is 78 refusals, and almost all
of them are lists: `pres`, `found`, `names`, `problems`, `accesses`, `calls`,
`lines`, `args`, `bindings`, `edges`, `failures`, `statements`, `scopes`,
`results`, `values`. They are the same list-of-lists the `flatMap` bucket needs.

### 4ak. A list behind more than one field

`this.functions.waiting.push(draft)` is a push on a list two fields deep. The
append lowering knew two places: a name, and one field of a name. Anything
deeper was a method of nothing. A place that is a field of a place is now read
into a name of the statement's own first — the owner is a reference, so the
push goes through the name and writes the object the source named — and the
append is the one a field of a name is.

This took the total from 726 to 725. It is one refusal, and it is worth more
than one: `semantics/ir-resolve.ts` is the resolver, and the list it pushes a
waiting function onto is a field of the resolver's own functions table.

### 4aj. An import under another name

`import { buildObject as buildMachineObject }` was refused, and the compiler's
own sources write nine of them — `parse as parseToml`, `buildObject as
buildMachineObject`, `setTimeout as sleep`. The import binds the export under
the name the file writes, but this linker is by name: one table holds every
function of every file, so a call written under an alias had to be compiled
under the name the module exports.

An import now records the alias beside the name it names, and three things
follow it. The call the file writes under the alias is emitted under the
exported name. The signature the graph seeds for the file is seeded under the
alias, which is the name the call is read against. The value a module exports
as a constant is bound under the alias, so a function that reads `TABLE` reads
the list the other module called `NAMES`. A type or a class renamed by the same
statement still resolves, because the type binding already recorded the pair.

This took the total from 735 to 726, nine exactly: every site was one refused
`as` and nothing behind it.

### 4ai. A collection an arrow answers

`const namesOf = (name: string): Set<string> => { ... }` states that the arrow
answers a set, and a caller asks the answer `has` and `add`. The call is written
as a call of the function the arrow lifted to — a name the source never wrote —
so the collection the arrow declared was recorded under no name at all, and
every question asked of its answer was a method of nothing. The arrow now
records its answer's collection under the lifted function's name, which is the
name the call reads, and a name bound to that call holds the collection too.

This took the total from 741 to 735, all six in `semantics/power-of-two.ts`,
whose `namesOf` is an arrow and whose sets are asked `has` and `add` eleven
times.

### 4ah. A collection keyed by a number

`new Set<number>()` and `new Map<string, Set<number>>` were refused because the
frontend's dictionary was keyed by a text or a reference. The runtime already
had the `_refkey` entries that take a double, so the model was the only thing
missing: a key is now a text, a reference or a number, and the call one
operation is lowered to is chosen by the key the collection declared.

The runtime keys a number by the bits of its double, written in base sixteen:
two writes of one number are one entry, and the text reads back as the number it
was. A zero is one key whatever its sign and every NaN is one key, which is what
the language's maps say. `+0` and `-0` are one entry, and every NaN is the same
entry; no key a program can write collides with a key it did not.

**A wrong answer found on the way.** A map of references — `Map<Box, Box>`,
where the value is a reference — was already reading past the object before this
slice: the dictionary read was the call that answers the double an entry holds,
so the IR typed the value a number and a field read of it read the runtime's
table as an object. Both backends segfaulted, and `Map<string, Box>` only worked
because a text key had a call whose answer is a reference. Every key form now
has one (`_get_ref`, `_get_refkey_ref`, `_get_numkey_ref`), and the frontend
picks it when the value is a reference.

This took the total from 746 to 741. It is worth less than the fifteen refusals
it removed because five of those sites then refused the next thing they held:
`toolchain/ir-machine.ts` and `toolchain/stack-frame.ts` keep a list in a map
(`Map<number, (readonly [number, number])[]>`), which is the list-valued
collection of the value-model list, and `semantics/power-of-two.ts` and
`semantics/liveness.ts` ask a set a function answered, which is the next
section. The refusals did not vanish; they moved behind a construct the reader
could not reach before, and the number says so.

### 4ag. A parameter default ends at its own comma

A class whose constructor wrote two defaults was read with one: the scan that
skips a parameter's default value ran through the comma into the parameters
after it, so the second parameter was never read and the field it initialised
was never typed. A default now ends at the comma of its own list, and the comma
inside a generic — `new Map<string, number>([["", 0]])` written as a field's
value — is a comma of the type, not of the list, so the skip of a *value* is
the one that stops at a comma and the skip of a *field* is not.

This took the total from 751 to 746.

### 4af. A program erases a type it did not used to read

The program parser — the one that reads `cli.ts` as the statements it runs —
erased a parameter's type by taking its first word. `string | undefined` left
the `|` where the reader wanted `)`, and an object type left its `{`. Both
desynchronised the body, and the statements after it were never counted. A type
is now read to the token its annotation ends at, with the braces, brackets and
angles of the type balanced inside it, and `as`/`satisfies` are the value with
its type erased.

This is what the entry module needed: `cli.ts` is the first file of the
self-build, and it is read as a program. It went from two refusals to four,
because the parser now reaches `switch` and `process.stdout` where it used to
stop; three other files fell by seven. The total went from 756 to 751.

**A finding.** A program that passes an object to a function of the program is
now read (an object type in a parameter used to be refused), and the machine
backend runs it while the C backend is killed by a segmentation fault. The
object a program allocates is not passed to a program function the way the C
backend reads it. Verification refuses the C candidate and the machine one is
delivered, so no build answers wrongly; the C backend cannot be the candidate
for such a program until the passing is fixed.

**What a default parameter still needs.** A program function with `x = 1` or
`maximum?: number` is still refused, because a call that leaves the parameter
out has no absent value to pass: the compiler's zero for a number is a number
the source may have written, and a body that asks `maximum !== undefined` would
then answer for a zero. This is the same absent value the roadmap names, and it
is the next value-model slice.

### 4ad. The signature across the module link

A runtime import binds a name, not a body: the function is compiled by the
module that writes it. The frontend knew the signatures of the file's own
functions and nothing of the functions it imports, so every call to one
answered `any` — and a field of the answer, `in` over it, and a method written
on it were refused. The graph had already read the module, so its analysis had
the signature; the link now hands it to the reading of the importer, by the name
the importer writes. A call that waits for a signature is a deferral like a type
that waits for the link, so the file is read again once the graph has answered,
and the refusal is not written into the first read.

Two smaller things in the same reading:

- The scan that reads the file's own signatures before its bodies stopped at a
  `{` that was the body's, so a result written as a union of records — a brace
  in the type and another for the body — was left unread and the declaration
  below its caller still answered `any`. It now ends the annotation where
  `skipFunctionBody` does.
- A union of shapes is one layout with a tag (see the next section), so the
  answer of a linked function can be asked about at run time.

This took the total from 778 to 756.

### 4ae. A union of shapes is one layout with a tag

`Outcome = { refused: string } | { applied: number }` is how the compiler says
"either" in its own sources, and `"refused" in outcome` is how it asks which.
The union erased to a record that named every field of every arm, and the
literal for one arm was laid out as *that arm's* fields: reading the field of
another arm read past the object, and `in` was answered as the constant truth
because the merged type declared the field. Both were wrong answers waiting for
a program that asked.

Every literal written at a union is now laid out as every arm's fields — zero
where the arm did not write one — and carries `__arm`, the index of the arm it
was written as. `in` over the union is a chain of comparisons on `__arm` against
the arms that declare the field, which is the question the language asks. The
same layout for every arm is also what makes a read of a field of another arm a
read of a zero rather than of memory past the object.

This is the tag the spec said a union of shapes needed. It took the total from
776 to 756, and it removes a wrong answer rather than only a refusal.

### 4ac. The rest of the arguments, and the signatures above the body

`export function workingTitle(...args: any[]): string` is how the sources write
one function that answers to several call shapes: two signatures above it say
how it is called, and the body reads the rest of the arguments as one list.
Neither was in the subset. `expected a parameter name` was the `...`, which the
parameter reader did not know, and `expected "{"` was the signature with no
body, which the declaration reader read as a function whose body it could not
find.

A signature with no body is now read as the signature it is: it records the
parameters and the result a call is read against, and the declaration is not a
function of the file — the body below it is. A rest parameter is one parameter
whose type is the list; a call to the function packs the arguments it wrote
after the fixed ones into a list of that element type, which is the list the
body reads. A dynamic element is boxed, so `...args: any[]` holds a text beside
a number and the body reads each back as what the call wrote.

This took the total from 783 to 778.

**Two wrong answers found on the machine backend.** A list of dynamic values
held a text's *pointer* in a slot whose reader asked the runtime to unbox a
handle, because the machine's conversion into a dynamic slot wrote no box at
all; and the handle the reader passed to the runtime was left in the
accumulator while the ABI takes the double in a vector register, so the text
read was whatever handle happened to be in `xmm0` — always the last one boxed.
Both are fixed in `ir-machine.ts`: a text and a number are boxed on the way
into a dynamic slot, and the handle is moved into `xmm0` on the way to
`blaze_rt_to_text`. A four-element list of mixed values read back as four
copies of the last value before this, on the machine backend only.

### 4ab. A function the text calls before it is written

A declaration is hoisted, but the text that calls a function need not come after
it: `parseReview` calls `readProposal` ninety lines below it. The frontend read
the file in order, so at the call it knew nothing about the callee — the call
answered `any`, and a field of the answer, a method on it, and `in` over it were
all refused.

The signatures of the whole file are now read before any body: the parameter
list and the result, not the body. A declaration is still read once, where it is
written, and the scan is an improvement on knowing nothing rather than a
replacement for that read — a signature the scan cannot parse (a pattern
parameter, a default whose type it does not follow) is left to the declaration.
A parameter written as a pattern still contributes the function's result type,
which is the part a caller needs.

This took the total from 785 to 783, and it is worth more than two refusals: it
is the difference between a call that knows what it answers and one that knows
nothing, and every later slice that types the result of a call a reader writes
above its declaration is standing on it.

### 4x. The text of a number written into a frame that is gone

Two wrong answers found while trying to read `Array.from`, and both are the
same bug in the two backends.

The text of a number is written into a buffer the *function* owns — a frame
slot, which is cheaper than an allocation for the common case of a number
interpolated into a template that copies it straight away. But `return
String(7)` answers that buffer, and the buffer dies with the frame:

    export function label(): string { return String(7); }
    console.log(label());            // the C backend printed one byte of
    console.log(label() + "!");      // whatever the next frame left there

The machine backend had it too, and passed only because the caller's next frame
happened to land elsewhere. Both now copy the text into the managed heap before
they answer it (`blaze_rt_string_new`), which costs one allocation per number
written as a text. A template that interpolates a number pays it twice — once
for the part and once for the join — and that is the price of an answer that
survives the call it was written in.

The second finding is why `Array.from` is not in this session's slices:
`Array.from({ length: n }, f)` cannot be read without the length of the list the
call *answers*, and a list a call answers has no length at all — it is a
pointer, and the count of its elements is left behind with the callee's frame,
unless the caller can recover it from the runtime's allocation header as
`map`'s can. That is a value-model slice, not a syntax one, and it waits. (The
length a list was built at is carried by the IR now, and the form is read in
§4cw.)

## The next slices

### What the measurement says now

62 refusals over 95 sources, 77 of them read whole. The report reads the
module graph a build reads — every source is a root, every project import is
resolved, and a file whose imports bind a type, a value, a signature or a class
is read again with them — so the number is what survives the link rather than
what waited for one. `core/version.ts` reads whole now that a directory entry
and a path are the compiler's own types (§4fn), which is the one source the
slices since the last measurement closed.

The number was five times larger than the standalone read's 421 because that
read was counting with a hand over the rest of the file: the first imported type
it could not resolve set the deferral, and every construct after it that would
have needed the link was skipped rather than reported. The linked read binds
those types and reports what is left, so 421 measured how far a parse got, not
what is missing. The largest buckets now, in order:

| refusals | refusal | what it needs |
| --- | --- | --- |
| 7 | `in` asks a value whose fields the type does not write down` | a dynamic value whose fields no layout writes: `"k" in n.value` where the field is `unknown`, which is the writable dynamic object §3 still owes |
| 7 | `only a named function is called` | four calls of package providers (the AI SDK transport, §5) and a callee an expression answers: `this.target[method]`, `(a ?? b)(url)` |
| 5 | `"map" is not a method` | a receiver the linked read cannot type: a promise, a host value whose declaration is a Node module, or a value an imported declaration erases |
| 4 | `"..." is not a value a program can read` | a list spread in a program body, whose arrays are numbers |
| 4 | `"catch"`, 4 `"then"` and 2 `"allSettled"` | a promise a body chains: the runtime has the promise and the await, not the methods of it |
| 4 | `JSON.stringify writes a list whose values are written where the list is` | a list of one element type is not a dynamic value the runtime's stringify walks |
| 3 | `"off"`, 3 `"once"` and the rest of `core/terminal-title.ts` | Node's streams and process events, which the host boundary has not replaced |
| 3 | `JSON.stringify writes one value` | the indent a third argument names |
| 5 | `a program cannot allocate Map` or `Set` | the collections a program body builds |
| 3 | `an empty array needs the type of its elements` | an empty literal whose element type no use states, still in the IR text parsers |
| 2 | `Object.entries reads a record or a map in a loop that names the two values` | the entries of a record whose type the link did not settle |
| 2 | `a function may not be declared inside a function` | a nested declaration, in the terminal title and in `recursion.ts` |

A refusal listed here is still not always a construct the frontend cannot read:
a file is linked against the declarations of other files, and a file that is
itself refused offers only what its partial read built. The queue is a queue, not
a verdict — the per-file delta is read before a slice is accepted.

The value-model slices still open, in the order they block the self-build:

- **A function reference stored as a value.** An arrow written directly in a
  program's statements is a bare code address (`functionRef`), not the closure
  an arrow in a function body becomes: a callback site takes it by name, and no
  backend stores one in a field. Every call through a function-typed field that
  the compiler now reads is written in a function body, so this is a residual
  of §4bx rather than a block.
- **An empty list in a field.** `{ children: [] }` needs the element type the
  field's interface states, and the linked read still refuses the literal where
  the interface, or the field's use, does not name it. It is the largest
  single-construct bucket left.
- **A list stored in a dictionary.** A dictionary's entry is one double, and a
  list is a pointer and a length: `Map<string, number[]>`,
  `Record<string, string[]>` and a set of lists are refused where the value is
  read, and `m.get(k) ?? []` with it. A list would have to be boxed — a block of
  its own whose handle is the entry — before a key can answer one.
- **A value whose type is an intersection of a union.** `DraftValue & { k:
  "buffer" | "sized" | "view" }` is a value of one of three kinds of the union,
  and a field of it — `held`, which is the array the block is — is the field of
  the narrowed kinds. The read keeps the whole union, so `held.values` is a
  field of nothing and its `map` is a method of nothing.
- **The host's directory.** `process.cwd()` is the directory a build runs in.
  The clock and the two streams a program writes are read now (§4cg, §4ch), so
  this is what is left of the host object: one file, `ai/commandcode.ts`, asks
  for the directory it runs in.

What was closed this session, and what each was worth:

| slice | total |
| --- | --- |
| a collection keyed by a number | 746 → 741 |
| a collection an arrow answers | 741 → 735 |
| an import under another name | 735 → 726 |
| a list behind more than one field | 726 → 725 |
| a captured value written by an arrow | 725 → 651 |
| an assignment where an expression goes | 651 → 618 |
| an optional chain reads the value once | 618 → 610 |
| an arrow takes the rest of a call's arguments | 610 → 608 |
| a text repeated | 608 → 601 |
| a text searched from a position | 601 → 598 |
| a value marked with void | 598 → 595 |
| a destructured rest element | 595 → 591 |
| a top-level list asserted or joined | 591 → 588 |
| a captured list held in a one-field object | 588 → 514 |
| flatMap is the lists its callback answers | 514 → 503 |
| shift and unshift are the two ends of a list | 503 → 494 |
| splice is a range replaced by the values written | 494 → 483 |
| a switch, a length, and a program's own output | 483 → 476 |
| `new Array(n)` and `fill` | 476 → 465 |
| a for loop that is not a counted loop | 465 → 449 |
| a default parameter in a program function | 449 → 448 |
| an import hoisted from where it is written | 448 → 443 |
| a method named length is a call | 443 → 442 |
| a method's result as a union of object types | 442 → 441 |
| an object type inside a type argument | 441 → 437 |
| a collection allocation's trailing comma | 437 → 433 |
| hasOwnProperty over an object's names | 433 → 430 |
| a pushed value read at the element the list holds | 430 → 429 |
| an arrow's concise body as an assignment | 429 → 428 |
| a collection written clear | 428 → 426 |
| a declared function as a collection callback | 426 → 421 |
| a union laid out with a leading bar (§4bp) | 2218 → 1839 |
| an expansion of a type made once (§4bq) | 1839 → 1841 |
| a class another module declares (§4br) | 1841 → 991 |
| what a collection's value holds (§4bs) | 991 → 945 |
| a signature a refused module still offers (§4bt) | 945 → 916 |
| a field a modifier is written in front of (§4bu) | 916 → 903 |
| the type a method writes for its result (§4bv) | 903 → 857 |
| a module that re-exports (§4bw) | 857 → 847 |
| a closure a layout field holds (§4bx) | 847 → 725 |
| the type a top-level declaration writes (§4by) | 725 → 698 |
| a default read at the parameter's type (§4bz) | 698 → 689 |
| the type an exported constant offers (§4ca) | 689 → 680 |
| the type a call reads its arguments at (§4cb) | 680 → 622 |
| the shape a value has across an arm (§4cc) | 622 → 609 |
| a view of a block (§4cd) | 609 → 602 |
| a whole number of sixty-four bits (§4ce) | 602 → 580 |
| a field a conditional spread leaves out (§4cf) | 580 → 574 |
| the error stream (§4cg) | 574 → 566 |
| the monotonic clock (§4ch) | 566 → 559 |
| the record a collection's element is (§4ci) | 559 → 548 |
| the members Extract and Exclude name (§4cj) | 548 → 537 |
| the list a narrowed value is, and the record a spread names (§4ck) | 537 → 529 |
| a type a module re-exports (§4cl) | 529 → 518 |
| an object written into a list (§4cm) | 518 → 515 |
| the type a top-level allocation writes (§4cn) | 515 → 509 |
| the element a list method answers (§4co) | 509 → 494 |
| a string is not a bracket (§4cp) | 494 → 488 |
| a key asks a dictionary (§4cq) | 488 → 485 |
| an arrow answers the record it wrote, a spread keeps the element's shape, and a text helper is a read (§4cr–§4ct) | 485 → 480 |
| the infinities, the greatest of a list, a compound length, a local `undefined`, and a bracket in a constant (§4cu–§4cv) | 480 → 472 |
| a field through a reference, the shape an assignment reads, a for-of over a constant, a key held in a name, `Array.from`, and the benchmark's gate (§4cw) | 472 → 447 |
| a string is not a bracket, a readonly result type, a conditional arm, the constant scan's annotations, a function type as a signature, and a class across a type-only import or re-export (§4cx) | 447 → 432 |
| an arrow's default, a typed loop index, a padded text, and the shape a slice keeps (§4cy) | 432 → 428 |
| a coalesce that keeps a collection, `Object.is`, a hex text, and a re-export (§4cz) | 428 → 415 |
| a map of lists, a declaration read before it is written, a push on an element, and `slice()` (§4da) | 408 → 359 |
| a conditional spread writes the zero of the field it leaves out (§4db) | 359 → 341 |
| a map under a number key, a window of a block, and the bytes of a text (§4dc) | 341 → 319 |
| the clock, and the bytes of a text read back (§4dd) | 319 → 306 |
| a method of an object literal, and an element of a field (§4de) | 306 → 299 |
| a wrapped whole number, the default order, and a view of part of a block (§4df) | 299 → 290 |
| a conditional spread into a union of shapes (§4dg) | 290 → 271 |
| a push on a choice of two places, and the keys of a layout (§4dh) | 271 → 265 |
| an await that holds the record its promise carries (§4dh) | 265 → 261 |
| a map of the pairs a callback writes (§4di) | 261 → 251 |
| a map that answers a list (§4dj) | 251 → 246 |
| a record spread into a record (§4dk) | 246 → 241 |
| a rest field (§4dl) | 241 → 236 |
| a spread whose value the read does not shape (§4dm) | 236 → 231 |
| an empty list a loop walks beside a set, an answer that names nothing, and a module read after its imports (§4dn) | 231 → 220 |
| a spread of a call, and a method of a class another module declares (§4dp) | 220 → 213 |
| a truth a literal writes is a truth the field holds (§4dq) | 213 → 213 |
| a reference a program body hands to a function (§4dr) | 213 → 213 |
| a promise a method answers (§4ds) | 213 → 213 |
| a hash is the runtime's SHA-256 hasher (§4dt) | 213 → 206 |
| a record built from a callback's pairs (§4du) | 206 → 204 |
| an arrow the use holds at a function type (§4dv) | 204 → 203 |
| a record rebuilt from the entries of a record (§4dw) | 203 → 200 |
| an object spread in a program body (§4dx) | 200 → 198 |
| the await of a call through an interface member (§4dy) | 198 → 197 |
| Promise.all settles a list into the values it carries (§4dz) | 197 → 196 |
| Date.parse reads a date text back (§4ea) | 196 → 194 |
| a list is reversed where it lies (§4eb) | 194 → 192 |
| a spread stands beside a value in Math.max (§4ec) | 192 → 191 |
| a text replaces the asking of its needle (§4ed) | 191 → 189 |
| a text splits at most as many fields as its limit names (§4ee) | 189 → 188 |
| a union keeps the records it mixes with its values (§4ef) | 188 → 187 |
| a union keeps the records it mixes with its values (§4ef), once the leftover debug print left | 187 → 186 |
| a program walks a value that is not a bare name (§4eg) | 186 → 181 |
| a text searched backwards asks at the last asking (§4eh) | 181 → 180 |
| a list of lists flattened is the lists it holds one after another (§4ei) | 180 → 179 |
| a promise that answers nothing leaves no value to collect (§4ej) | 179 → 178 |
| the entries of a source assigned into a dictionary (§4ek) | 178 → 177 |
| a for loop whose step is an assignment is the while it writes as a for (§4el) | 177 → 176 |
| an async method of an object literal states its type parameters (§4em) | 176 → 178 |
| a map entry written as an asserted tuple is the entry it asserts (§4en) | 178 → 176 |
| the captures a pairs callback reads are the helper's own (§4eo) | 176 → 171 |
| entries sorted is the record the comparator orders (§4ep) | 171 → 171 (valueKey still refuses for its replacer) |
| a typed array built from a list of numbers is the list written as its elements (§4eq) | 171 → 170 |
| a number question reads its value twice where the value is a maths read (§4er) | 170 → 169 |
| a whole number wrapped from a value that is a whole number reads (§4es) | 169 → 166 |
| a text read at a byte position is the code point there (§4et) | 166 → 165 |
| a nested map a class field writes is the map it was written as (§4eu) | 165 → 163 |
| a number read in its radix and a text of a code point (§4ev) | 163 → 161 |
| a spread of a text, `Array.from` of one, and a place behind a call (§4ew) | 161 → 157 |
| a choice of two text reads is a text (§4ex) | 157 → 155 |
| a push on the list an indexed field holds (§4ey) | 155 → 154 |
| a statement that begins with a bracket is the expression it writes (§4ez) | 154 → 153 |
| the collection bindings a body writes are the body's own (§4fa) | 153 → 152 |
| a text encoder writes the bytes a text is written as (§4fb) | 152 → 148 |
| a buffer read as floats, and a spread written at the list's element (§4fc) | 148 → 143 |
| `Buffer.from` reads a text as bytes, and latin1 writes them back (§4fd) | 143 → 141 |
| a record keyed by the numbers a source computed (§4fe) | 141 → 139 |
| a length written through a field of a field (§4ff) | 139 → 138 |
| a name holding a choice of two regular expressions is a regex (§4fg) | 138 → 138 (the program parser counted the same body) |
| a copy made by `structuredClone` is the value it copies (§4fh) | 138 → 136 |
| a program asks the kind of a value with `typeof` (§4fi) | 136 → 135 |
| a pattern names the elements of a value (§4fj) | 135 → 134 |
| a whole number written in base two (§4fk) | 134 → 133 |
| a list joined with a value, and a loop that awaits (§4fl) | 133 → 132 |
| a call of what a call answered, and the callee of an indirect call (§4fm) | 132 → 131 |
| the host's directory entry and path work as the compiler's own types (§4fn) | 131 → 124 |
| a class built on another, and the absence a choice of texts answers (§4fo) | 124 → 123 |
| a promise a body chains (§4fp) | 123 → 112 |
| the JSON of a list a program builds, and the tuple type a pair is (§4fq) | 112 → 108 |
| Promise.allSettled reports how each promise settled (§4fr) | 108 → 104 |
| a number written at its significant digits (§4fs) | 104 → 103 |
| a union asks the kind of the value it holds (§4ft) | 103 → 102 |
| a splice writes the field a chain of fields names (§4fu) | 102 → 101 |
| a block the file allocates at the top is typed by its constructor (§4fv) | 101 → 98 |
| the path namespace the compiler reads its own imports through (§4fw) | 98 → 97 |
| an empty list in a call argument takes the type the call says (§4fx) | 97 → 94 |
| a map spread into a list is its entries (§4fy) | 94 → 91 |
| a union narrows by its tag field (§4fz) | 91 → 90 |
| a callback declared below the arrow that uses it (§4ga) | 90 → 88 |
| an intersection with a tag narrows a union to its arms (§4gb) | 88 → 87 |
| a map value read through a fallback keeps its fields (§4gc) | 87 → 86 |
| a callback annotated `any` takes the element the method hands it (§4gd) | 86 → 85 |
| a file the compiler opens is the compiler's own handle (§4ge) | 85 → 83 |
| a compiled object knows the names its layout wrote (§4gf) | 83 → 76 |
| a generic function that answers its parameter's type (§4gg) | 76 → 75 |
| a method of an object type inside a field (§4gh) | 75 → 71 |
| a template interpolation reads the shapes its imports bind (§4gi) | 71 → 69 |
| the entries of a map are a list of pairs a callback walks (§4gj) | 69 → 64 |
| `Object.assign` widens the object a declaration wrote (§4gk) | 64 → 63 |
| `JSON.stringify` writes a record at the indent the source names (§4gl) | 63 → 62 |

**Wrong answers found on the way.** A map of references read the double an entry
holds, so the IR typed the value a number and a field of it read the runtime's
table as an object; both backends segfaulted on `Map<Box, Box>`. Two identical
calls in one expression were inlined once (§4an). A store through an object
reference did not compile as C (§4as). An arrow that only read a name another
arrow wrote read a name the box had replaced (§4at). And a choice of a length and
a number was read at the unshaped reference an arm of another type falls back to
(§ "Read a choice of two values at the type they share"). `semantics/power-of-two`'s
`namesOf` is an arrow, so the set it answered was a set the read did not know and
`has`/`add` on it were methods of nothing. And an array a *callee* builds was not
the turn's block, so a loop that appended to a list dropped what its first turn
appended (§4ax).

**A type-layer bug, found and fixed.** `type X = | A | B` — the leading bar the
sources write when the members are laid out one per line — was read as a member
that is `any`, and a union whose first member is `any` is `any`, so every such
declaration erased. An earlier measurement said fixing it lowers the frontend's
own count by five and raises `semantics/python.ts` by twenty-two, because the
types it erases are the ones whose lists are walked with `flatMap`; the linked
read resolves those declarations, so the same fix is worth 379 refusals and
`semantics/python.ts` falls (§4bp).

**What the entry still needs.** `cli.ts` is the first file of the self-build and
is read as a program. The linked read refuses ten constructs: seven
`process.stdout` writes — the error stream is the runtime's own — two field names
in an object literal, and the name of a declared value. The last three are
program grammar and their own slice; the entry's default parameter and its
`switch` are read now.

### The roadmap

The order below is the order of leverage. The first three slices — the gap
report (0), the type layer (1) and the platform boundary (4) — have landed what
they can without the value model: the report and the boundary are in place, and
the type layer carries everything except the optional parameter, which needs an
absent value. The boundary also added two sources, so the budget records the
value and module forms those sources use and the next slice has to carry.

### 0. Make the gap a number

The report is in place: `test/self-host-gap.ts` reads the compiler's sources as
the module graph a build reads — every source is a root, every project import is
resolved, and a file whose imports bind a type, a value or a signature is read
again with them — and groups the refusals by the message the frontend writes.
`test/self-host.test.ts` holds the total as a budget. A change may not raise it,
and a slice must lower it.

A source is still a root of its own, so a file no import reaches is measured:
the graph is the whole tree, not one binary's closure. A build reads strictly —
it stops at the first file it refuses — and the report reads tolerantly, so one
refused file does not hide every file that imports it. An import the tree does
not hold, such as a package or a host module, is left unbound: the report asks
what the frontend reads of a file, not which packages the tree depends on.

It covers `src/compiler` only. The tests, benchmarks and scratch programs are not
part of the compiler binary and are not compiled into it.

### 1. Erase the type layer

Read and discard the type-only syntax the source already uses:

- `interface` and `type` declarations, including exported ones;
- generic parameters and arguments on functions, classes and types;
- `as` and `satisfies`, including `as const`;
- `import type` and `export type`, and the `type` modifier in a named import;
- angle-bracket assertions, `const x = <number>v`;
- a `return;` in a function that returns nothing;
- a class member named with a modifier word, such as a method called `declare`.

This is not a semantic change. The source does not rely on any type at run time,
and the compiler's own type checker is what enforces the source's types today.
The type-only import alias, the angle assertion, the bare return and the
modifier-named member are carried now. So is the information the type text
carries: an interface is a record of fields, a type alias is the type it names,
and an annotation in one module resolves an imported declaration through the
module that wrote it. A field of a `Contract` is a `Definition`, its `calls` is
a list of `Call`, and a text field is the receiver of a text method. A union of
records is the fields of every arm, including the bar the sources write before
the first member, so a value held at a union is read field by field (§4bp). The
remaining type-shaped construct is the optional parameter, `x?: T`: an absent
value is not the zero of the type, and the value model has no absent value until
slice 3.

Exit criterion: every compiler source is read to its last line, and the report
holds only runtime constructs.

### 2. Read the JavaScript the source uses

The source is ordinary modern JavaScript once the types are gone. The constructs
below are independent enough to land one at a time, in this order:

- `?.` and `??`, which lower to the conditional and the null check the source
  would have written.
- A collection method (`map`, `filter`, `forEach`, `every`, `some`, `find`,
  `findIndex`, `reduce`, `sort`) is a function of the file that walks the array,
  and the callback's parameters are the element type the array holds, the
  position and the array itself. A callback therefore needs no annotation, and
  the element type of a record still reaches its fields through the shape the
  contract erases. An explicit annotation is what the parameter is read at.
- Spread and destructuring in declarations, parameters, calls, array literals
  and object literals. Object shorthand, `{ line }`, is read as the field it
  names, and spreading a constant object writes out the fields it holds. A
  parameter written as `{ a, b: c }` or `[a, b]` is held at a name of the
  pattern's own and each bound name is a declaration read out of it, so the
  functions, arrows and methods that take a record or a pair are read as they
  are written, and a `for..of` over `[key, value]` binds each part the same way.
  An array pattern reads any list, not only a literal, and a name is held at the
  element type of that list and a field at the type its object declares. A gap
  (`[, name]`) names the position after it, and a rest element still needs the
  slice it denotes.
- `switch` (about 200 occurrences), lowered to the chain of comparisons the
  current subset already has.
- A number written with `_` between its digits, as `600_000` is.
- `throw` and `new Error`, plus `error.message` in a catch arm. Try/catch and
  `finally` are already carried; only the throwing side is missing.
- Class getters (8 occurrences) are carried: a getter is a method with no
  parameters, and a member read of it is the call. A setter is still refused.
  Inheritance is limited to `extends Error` and one internal reader hierarchy;
  support it or write those three classes out. Do not carry a general
  inheritance model to compile four uses.
- Module forms: `import * as`, renamed imports, re-exports, and a module value
  another module imports. A top-level constant is already read by the functions
  of its own file, and a file of declarations is a library rather than a
  program; what is missing is the module graph carrying that value across files.
  A self-hosting compiler has a module graph, so the linker's "one name per
  function" rule has to become a module-scoped name. A type, a value, a
  signature and the description of a class already cross the link; a class
  another module declares is read through its instances from the fields and
  methods its declaration writes (§4br).

Exit criterion: the source's control flow and expressions parse; only data and
host refusals remain.

### 3. Carry the compiler's data

The compiler is a program over trees, records and text, and the value model has
to carry those without a rewrite into numeric arrays:

- **`undefined` and absence.** The compiler distinguishes a missing field from a
  zero. The current value model has `null` and "nothing", but not an absent value
  with its own identity; add one before the JSON-shaped code is ported.
- **Dynamic objects.** Object literals, field writes, text-keyed lookup and the
  operations the source uses: `Object.keys`, `values`, `entries`,
  `fromEntries`, `assign`, `hasOwn`, `isFrozen`. `Object.keys` and
  `Object.values` of a constant object are already written out as arrays; the
  rest still need the writable, iterable dynamic shape. The runtime already has
  a dynamic object for JSON; this makes that shape writable and iterable, while
  the layout pass keeps its static objects beside it.
- **Arrays.** A length inside the block so `push` is linear, arrays of arrays,
  and `slice`, `splice`, `shift`, `unshift`, `concat` and `Array.isArray` (and
  the `Array.from({ length: n }, f)` form, §4cw). Text and reference arrays
  already exist, and the growth the source does through a name or a field is
  lowered to the helper that walks the block. A written-out list is now a block
  the runtime hands out, in the C backend as in the machine backend, so a list a
  function returns or a constructor stores in a field outlives the frame that
  wrote it; an empty list is built the same way when the declaration, field or
  return type names its element. The element type now travels through `as` and
  `satisfies`, the arms of a conditional, the right side of `??`, an object
  field, a call argument and a nested list, so `condition ? [] : [1]` is a list
  of numbers without a separate annotation. `this.items.push(x)` writes the
  field back into the object it was read from, and `a.push(x, y)` is one block
  and one copy for every value. `at` and `slice` read one element and copy a
  range. What is still missing is `splice`, `shift`, `unshift`, `concat`, the
  remaining `Array` constructors, and a list whose element is itself a list as
  a field of a class.
- **Maps and sets.** A value is a number, a text, a truth or a reference, and a
  key is text or a reference: a reference key is the handle itself, written as
  the address it carries, so two names for one object are one key. `get`, `set`,
  `has`, `delete` and `add` read and write each. A `for..of` walks the entries in
  the order they were written, `keys()` and `values()` answer a block of the
  element type, and `entries()` names the key and the value without building the
  pair. A map is built empty, from an array of pairs and from another map; a set
  from its elements. Still missing: keys that are numbers or arrays, values that
  are arrays, and `Object.fromEntries`.
- **Text.** `trim`, `includes`, `startsWith`, `endsWith`, `indexOf`, `slice`
  and `split` are carried. A split is a function of the file, not a runtime
  service: it counts the fields with `text.indexOf`/`text.slice` and then writes
  them, and an empty separator cuts the text into its characters. Still missing:
  `replace`, `toLowerCase`, `repeat` and `padStart`/`padEnd`, except where the
  first argument of `replace` is a regular expression.

  Regular expressions are carried by a small backtracking engine in the
  compiler runtime (`runtime/abi.ts`), reachable through the text helpers so it
  needs no host service: it supports literals, `.`, character classes and
  ranges, the `\d \w \s \b` escapes, `\n \r \t \xHH \uHHHH`, anchors, groups,
  non-capturing groups, alternation, greedy and lazy `* + ? {m,n}` quantifiers,
  and the `g`, `i`, `m` and `s` flags. A literal is the pattern and flags it was
  written with, held as the two texts a variable of `RegExp` type holds;
  `new RegExp(text, flags)` builds the same pair at run time. `test` and `exec`
  are the expression's methods, and `replace`, `split`, `match`, `matchAll` and
  `search` are the text's. Lookaround and backreferences are not carried,
  because no pattern in the compiler's own source writes one.

Exit criterion: a compiler module that does no host I/O runs natively and its
existing tests pass.

### 4. Put the host behind `core/platform.ts`

The boundary is in place: `core/platform.ts` is the set of host services the
compiler asks for, `core/platform-node.ts` is the only file that names a Node
module, and `test/platform-boundary.test.ts` fails when another source imports
`node:*`.

What is left is the native side of the boundary:

- files: read, write, append, stat, list, make a directory, rename and remove;
- processes: spawn with argv, environment, working directory and pipes; wait for
  an exit status;
- the process itself: argv, environment, cwd, stdout, stderr, stdin, exit;
- time, monotonic clock, random and a hash (the fingerprint needs SHA-256);
- network: an HTTP client with TLS, for the model providers.

Pure path and URL work (`join`, `resolve`, `dirname`, `basename`, `extname`,
`fileURLToPath`) still runs through the Node adapter. It moves into the compiler
as ordinary functions once the native adapter exists; it does not need a host
service. JSON is already carried by the runtime. The runtime ABI grows the
entries the native adapter needs, one entry per operation, the same way it
already carries file reads, environment and the clock.

The compiler's use of the `process` global is not behind the boundary yet.
`process.argv`, `process.env`, the streams and the exit status are the next set
of host names to move, because a native binary has its own process object.

Exit criterion: the compiler typechecks and its tests pass with Node behind the
adapter, and the adapter is the only file that names a Node module.

### 5. Replace the packages

Three dependencies are in the way of a native binary:

- **`smol-toml`** reads `blaze.toml`. Either write the TOML reader the project
  files need in the subset (they are small: strings, numbers, booleans, arrays
  and tables) or keep project parsing in the Node bootstrap until the native
  compiler can read its own project. The first fixed point needs the former.
- **The AI SDK** is the model transport. Put it behind one adapter and give the
  native compiler an HTTP + JSON transport for the providers it must speak. The
  first fixed point may use `--model replay` and avoid the network entirely;
  model review is then the last dependency to arrive, not the first.
- **`zod`** validates one provider's answers. Hand-written checks in the same
  adapter are enough, and they are code the compiler can compile.

### 6. Package and build the compiler

The compiler is a project, not a single file. Before rung 4 it needs:

- a `blaze.toml` for `src/compiler` that names the real entry module, the module
  graph and the output binary;
- module resolution over the compiler's own directory layout, including
  `index.ts`, relative paths and the package boundary;
- the toolchain services a build uses: spawning `cc`, `as`, `ld` (and `nim` when
  asked), reading their stderr, and turning a non-zero exit into the compiler's
  own diagnostic;
- atomic file writes and `.blaze/` state, or a documented flag that turns
  incremental state off for the self-build;
- the fingerprint at run time. The native compiler either reads its own installed
  sources, as the Node compiler does, or embeds the fingerprint at build time.
  Embedding is simpler and turns the fingerprint into part of the build; reading
  keeps `blaze inspect` honest about an edited tree. State which one the binary
  uses, and test it.

Exit criterion: rung 4's binary builds a program, then the compiler, from a clean
checkout.

### 7. Close the fixed point

Run the ladder as a test: Node builds stage 1, stage 1 builds stage 2, stage 2
builds stage 3. Compare the three on the conformance corpus:

- exit status, stdout and stderr of every command;
- the IR text (`blaze ir`) for every function of every fixture;
- the build record, the selected candidate and the delivered program's output;
- the program built from a fixture, run on its own toolchain.

Add a deliberate failure case too: a source the frontend refuses must be refused
by all three with the same message and detail. A native compiler that agrees only
on the happy path is not a fixed point.

## What is not in scope for the first fixed point

- Compiling `test/` and `bench/`. They are not part of the binary and their
  oracle is `node:test`, which the native runtime does not need to carry.
- `blazeup` and `src/optimizer`. They are a separate package and a separate
  program.
- Every model provider. The native compiler needs the replay path and one HTTP
  transport; the rest can stay behind the Node adapter until later.
- Incremental builds, if a self-build can be made deterministic without them.
  They are a performance feature, not a correctness one, and the first fixed
  point may run with `--recompile`.
- Performance. The native compiler may be slower than Node at first. The goal is
  the same answer, not the same speed.

## How progress is measured

The only useful measure is the gap report from slice 0. It answers three
questions at once:

- how many constructs the frontend still refuses, grouped by the reason it
  gives;
- which sources are read cleanly, so a slice that fixes one module is visible;
- whether a change made the subset smaller while fixing one program.

A source is not "supported" because a sample of it compiles. It is supported when
the whole module is read, its tests pass under the native build, and the compiler
still refuses the constructs it does not carry with the same message it gave
before.

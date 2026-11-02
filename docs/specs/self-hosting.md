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

The gap is measured, not guessed: `test/self-host.test.ts` reads every source and
holds the refusal count as a budget. When the report was added, 1 of the 91
sources (`semantics/module.ts`, which is types alone) was read and 6339
constructs were refused. The type-only slice below lowered the count to 6248.
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
not lower the budget, so it is not in this slice.

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
`map`'s can. That is a value-model slice, not a syntax one, and it waits.

## The next slices

### What the measurement says now

746 refusals over 94 sources, 17 of them read whole. The largest buckets, in
order, and what each of them is:

| refusals | refusal | what it needs |
| --- | --- | --- |
| 42 | `an empty array needs the type of its elements` | mostly the standalone read: the element type is a field's, written in a module the report does not link. The linked read settles most of them |
| 34 | `expected ")"` | cascade: a statement refused inside a call's arguments leaves the rest of the call to be read as statements. `toolchain/driver.ts` still earns the most, from constructs inside class members |
| 20 + 14 + 9 | `an arrow function writes "found" / "changed" / "pres"` | a captured value written back, which is the box below |
| 17 | `"+=" follows a complete value` | an assignment used as a value, as `${this.builds += 1}` is |
| 14 | `"flatMap"`, 13 `"map"`, 14 `a Map is built from entries` | a list the callback answers, which is a list of lists |
| 14 | `a spread argument is not part of the call subset` | `push(...list)`, `arr.splice(i, n, ...xs)` and `Math.max(...xs)` |
| 14 | `an arrow function writes ...` | the box above |
| 12 | `expected a parameter name` | an arrow whose parameter list holds a default or a rest parameter the arrow reader does not know |
| 11 | `the function map walks the array with must answer a number, a truth, a text or a reference` | a callback that answers an object |
| 10 | `Object.values` / `Object.keys` of a constant object | a runtime record in the standalone read; the linked read types it |
| 10 | `an object spread reads a constant object` | the same |
| 10 | `an optional chain reads the value before ?. twice` | a chain whose guard is a call that is not repeatable |

The value-model slices still open, in the order they block the self-build:

- **A captured value written back.** An arrow's body is a function of the file,
  and a name it writes is a name of the function that wrote the arrow, which the
  lifted function cannot reach. It needs the name to become a box in the
  enclosing function and every read and write to go through it.
- **An absent value.** A default parameter and an optional parameter need a
  value that is not the zero of the type. `function optionNumber(value: string |
  undefined, ..., maximum?: number)` is the first function of `cli.ts`, and a
  program function that omits `maximum` has nothing sound to pass.
- **A list's length.** `list.length = n` truncates. A list is a pointer and a
  length, and the length is the runtime's for an allocated block and beside the
  name for a literal one.
- **A list a callback answers.** `flatMap`, a callback that returns an object,
  `new Map(entries)`, `Object.values` of a constant: all need a list of lists,
  which the contract cannot spell.
- **A collection keyed by a number.** `new Set<number>()` and
  `Map<string, Set<number>>` are refused because the frontend's dictionary is
  keyed by text or a reference; the runtime already has `_refkey` entries that
  take a double, so the model only has to carry the key's type.
- **Two object layouts for one interface.** An object literal's list field is
  typed `array<T, n>` from the length of the literal, so `{ children: [] }` and
  `{ children: [a, b] }` are two layouts and cannot be one `Node`. The IR's own
  nodes are written exactly that way, so this blocks the self-build at the
  object pass.

**A type-layer bug, found and not fixed.** `type X = | A | B` — the leading bar
the sources write when the members are laid out one per line — is read as a
member that is `any`, and a union whose first member is `any` is `any`, so every
such declaration erases. Fixing it lowers the frontend's own count and raises
`semantics/python.ts`, because the types it erases are the ones whose lists are
walked with `flatMap` and with callbacks that are not arrows yet. It is a real
bug and it will pay once those methods are read.

### The roadmap

The order below is the order of leverage. The first three slices — the gap
report (0), the type layer (1) and the platform boundary (4) — have landed what
they can without the value model: the report and the boundary are in place, and
the type layer carries everything except the optional parameter, which needs an
absent value. The boundary also added two sources, so the budget records the
value and module forms those sources use and the next slice has to carry.

### 0. Make the gap a number

The report is in place: `test/self-host-gap.ts` reads every compiler source and
groups the refusals by the message the frontend writes, and
`test/self-host.test.ts` holds the total as a budget. A change may not raise it,
and a slice must lower it.

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
a list of `Call`, and a text field is the receiver of a text method. The
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
  function" rule has to become a module-scoped name.

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
  and `slice`, `splice`, `shift`, `unshift`, `concat`, `Array.from` and
  `Array.isArray`. Text and reference arrays already exist, and the growth the
  source does through a name or a field is lowered to the helper that walks the
  block. A written-out list is now a block the runtime hands out, in the C
  backend as in the machine backend, so a list a function returns or a
  constructor stores in a field outlives the frame that wrote it; an empty list
  is built the same way when the declaration, field or return type names its
  element. The element type now travels through `as` and `satisfies`, the arms
  of a conditional, the right side of `??`, an object field, a call argument and
  a nested list, so `condition ? [] : [1]` is a list of numbers without a
  separate annotation. `this.items.push(x)` writes the field back into the
  object it was read from, and `a.push(x, y)` is one block and one copy for
  every value. `at` and `slice` read one element and copy a
  range. What is still missing is `splice`, `shift`, `unshift`, `concat`, the
  `Array` constructors, and a list whose element is itself a list as a field of
  a class.
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

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

The compiler is 93 non-test, non-benchmark, non-scratch TypeScript sources, about
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
a getter to 5121, and the `_` separator in a number to 5068. The refusals fall
into six frontiers:

- **Type-only syntax.** Most of it is already carried. The remaining type-shaped
  refusal is the optional parameter, which needs an absent value the value model
  does not have yet.
- **The JavaScript expressions the source uses.** Optional chaining (`?.`),
  nullish coalescing (`??`), spread, destructuring (declarations, parameters and
  assignment), object shorthand, `switch`, `throw`, class getters and regular
  expression literals, and the module forms (`import * as`, renamed imports,
  re-exports).
- **Values a module exports.** A top-level constant is read by the functions of
  its own file, where the value is written into the body. A value another module
  imports is not carried: the module graph still offers functions only, and
  `export const` in another file is refused at the import that names it.
- **The value model.** The compiler relies on `undefined`/absence, dynamic
  objects with text keys, maps and sets of references as well as numbers,
  arrays that grow, arrays of arrays, and text methods including regular
  expressions.
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

## The next slices

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
modifier-named member are carried now. The remaining type-shaped construct is the
optional parameter, `x?: T`: an absent value is not the zero of the type, and the
value model has no absent value until slice 3.

Exit criterion: every compiler source is read to its last line, and the report
holds only runtime constructs.

### 2. Read the JavaScript the source uses

The source is ordinary modern JavaScript once the types are gone. The constructs
below are independent enough to land one at a time, in this order:

- `?.` and `??`, which lower to the conditional and the null check the source
  would have written.
- Spread and destructuring in declarations, parameters, calls, array literals
  and object literals. Object shorthand, `{ line }`, is read as the field it
  names, and spreading a constant object writes out the fields it holds. A
  parameter written as `{ a, b: c }` or `[a, b]` is held at a name of the
  pattern's own and each bound name is a declaration read out of it, so the
  functions, arrows and methods that take a record or a pair are read as they
  are written, and a `for..of` over `[key, value]` binds each part the same way.
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
  `Array.isArray`. Text and reference arrays already exist; the growth, the
  nested shape and an array as a class field do not. An empty list written in a
  slice context, `const xs: string[] = []`, is carried; a function that answers
  `[]` where it declares a slice is not yet: the literal's block is the frame's,
  and the caller is handed a pointer into a frame that has returned. That needs
  the value copied into an owned block before the return.
- **Maps and sets.** Values that are text or references, keys that are not only
  text, iteration (`for..of`, `keys`, `values`, `entries`) and `Map`/`Set` as
  fields. A compiler's symbol tables are maps of references.
- **Text.** `trim`, `includes`, `startsWith`, `endsWith`, `indexOf` and `slice`
  are carried. Still missing: `replace`, `split`, `toLowerCase`, `repeat` and
  `padStart`/`padEnd`. A runtime regular-expression engine is a decision of its
  own: the source has about 180 regex literals, and rewriting them as
  hand-written scanners is a larger and more fragile change than carrying a
  small engine. Choose the engine before porting `semantics/contract.ts`.

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

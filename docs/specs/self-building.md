# Blaze compiling Blaze

## What it is

Today `blaze` is a TypeScript program run by Node: `src/compiler/cli.ts` and the
modules under it. Self-hosting means a `blaze` binary, produced by Blaze from
that same tree, that builds the next `blaze`. It is not a second compiler
written in another language and it is not a rewrite of the programs Blaze
compiles: the source of the compiler is the input, and the tests are the same
tests.

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
| 2 | `blaze build` on a library | code generation, the assembler, the linker and spawning a toolchain |
| 3 | `blaze build` on a program | the program body, the runtime and running the delivered binary |
| 4 | `blaze build` on `src/compiler` | the whole compiler, including its own module graph |

## Where the source stands

The measured tree is 107 compiler sources, and the frontend reads all 107 whole:
`test/self-host.test.ts` reports **0 refusals**. The queue is empty, so the gate
is no longer the frontend but what a native build does with the whole module
graph (see "Where the self-build stands"). The sources are already written
as **erasable TypeScript**: `erasableSyntaxOnly` is on in
`src/compiler/tsconfig.json`, so no `enum`, `namespace`, parameter property or
`import =` carries runtime behaviour, and every `interface`, type alias,
generic, `as`, `satisfies` and `import type` can be erased rather than modelled.

The pipeline the sources are written for is:

| stage | module | what it does |
|---|---|---|
| frontend | `semantics/typescript.ts` | reads a module into declarations, bodies, types and imports |
| module graph | `semantics/module-graph.ts` | resolves imports, links types/values/signatures, rereads files with them |
| contract | `semantics/program.ts`, `semantics/contract.ts` | builds one contract per function, validates it and the body |
| semantic IR | `semantics/ir-function.ts`, `semantics/ir-validate.ts` | resolves a body into typed values, blocks and calls |
| object pass | `semantics/objects.ts`, `semantics/calls.ts` | lays out the objects, links every call to its symbol |
| backends | `toolchain/ir-c.ts`, `ir-machine.ts`, `ir-wasm.ts` | lower the IR to C, x86-64 machine code or WebAssembly |
| runtime | `runtime/abi.ts` | the host services every backend and the native adapter answer |

The self-build uses the `machine` backend (C and the assembler/linker), the
runtime in `runtime/abi.ts`, and the C toolchain. A native compiler binary is a
program the compiler builds from this tree with `src/compiler/blaze.toml`; the
project maps `#host/model` to the native adapter and `#host/platform` to the
native adapter. Neither mapping needs a model: a build with no `[model]`, no
`--model` and no `AI_MODEL` runs the rules alone, lowers the IR it resolved,
verifies it and reviews nothing. Provider review, replay included, is an
optional input to a build and never a prerequisite for self-building.

### The host boundary

`core/platform.ts` is the only host boundary the compiler sources name. It
re-exports `#host/platform`; `package.json` maps that to
`core/platform-node.ts` for the Node compiler, and `blaze.toml` maps it to
`core/platform-native.ts` for the self-build. The native adapter names no host
module and no host object: it is written in the subset and answers the same
names over the runtime ABI. The gap report measures the native adapter and the
sources a native build reaches; the Node implementation is a host's
implementation and is not part of the binary.

The host crosses as functions, not as one `host` object: `hostArguments`,
`hostWriteOut`, `hostWriteError`, `hostCwd`, `hostAsk`, `hostSetExitCode`,
`hostBoundHeap`, `hostSpawnSupport`/`hostSpawn`, `hostOnExit`, `hostOnSignal`
and `hostRaiseSignal`. A module-level object annotated with a layout is held as
a shape in the file that writes it, and a compiled function in another module
has no environment to read it from; a function crosses as a link edge. Both
implementations answer the functions, so no source branches on the host.

The runtime gained the text command line the compiler needs: the C and Nim
drivers hand the runtime the host's `argv` texts beside the numeric arguments a
program reads (`blaze_rt_host_arguments_set`, `blaze_rt_host_argument_count`,
`blaze_rt_host_argument`), and `stdoutWrite` writes the output stream the way
`process.stderr.write` writes the error stream.

### Async text results

An async arrow is lifted like any other closure, but its own signature must
still answer the promise handle, with the payload type beside the contract.
The frontend used to give the lifted arrow the payload type as its return type
and no `promise` field. A caller's `await` then handed the text itself to
`Promise.await.value`, which takes the handle, and the IR validator refused:

```text
argument 1 of Promise.await.value is passed as a text and is taken as a ref<any>
```

`readArrow` now passes its async flag into `liftArrow`; the lifted function is
marked async and registered as a promise function, so its contract answers
`ref<any>` and carries the text payload beside it. The caller lowers to
`Promise.await.text` over the closure's handle. `test/self-build-regressions.test.ts`
holds the lifted signature and the awaited call; `test/self-host-ir.test.ts` is
the gate that catches a recurrence in compiler source.

### The runtime ABI

The runtime is one ABI with one entry per service. The earlier squashed work and
this tree each wrote host services; the runtime now carries both sets, with one
definition per name and the shared entries keeping the earlier signatures:
`file_write(path, text, append)` answers 1, `file_read(path, mode)` answers a
managed text, `dir_make(path, parents)` takes the recursive flag, `sleep_ms`
answers 1 after the wait. The C, Nim and wasm hosts answer the same names and
the same answers, because a fixed point compares what the hosts answer and not
only what they accept.

Every entry is implemented on every side of the boundary: the C runtime, the
Nim adapter (`runtime/nim.ts`) and the wasm host (`toolchain/wasm-host-runtime.ts`).
`test/runtime.test.ts` holds that completeness as a test.

### What the frontend carries of the compiler's own sources

The linked module graph reads the compiler's sources whole, including:

- interfaces, aliases, generics, unions, `keyof`, `Extract`/`Exclude`,
  `Omit`/`Pick`, mapped and conditional types, and imported type one module
  declares;
- classes and closures, including a class another module declares, a method
  written on an imported type, a field read at the field's type, `extends
  Error` and `instanceof Error`;
- module values: a constant the file writes out is inlined, a value the file
  holds as state or constructs is read through the getter the module wrote,
  and a value a module re-exports is offered by that module along the
  re-export chain;
- an object pattern over a `Record<string, V>` reads each field through the
  dictionary's key, and the rest of the pattern copies the entries the pattern
  did not name;
- a bracket read over an object the file wrote is the chain of the keys it
  wrote, ending in absence;
- a name held at a function type is called through the value at the signature
  the type states (`ticker(() => 1, 10)`, `make()(7)`);
- `Math.fround`, the whole-number operators, and a choice of written whole
  numbers widened to the wide side it is used beside;
- the text codecs: `new TextEncoder()`/`new TextDecoder()` are compile-time
  markers, and a closure that captures one is handed the zero it is;
- the contract language: a truth returned by a function is `result == true`,
  and a field a constant object does not write is the absence the optional
  property is.

### The refusal queue

`blaze ir` on `src/compiler` contracts the whole module graph without refusing
anything: `test/self-host-gap.ts` reports zero. Every construct the compiler
writes is one the frontend reads, so there is no longer a queue of refusals to
work through. The constructs that used to be on it — `BigInt(text)` and its
wraps, `Number(bigint)`, `structuredClone`, `Array.from`, a member read through
a cast, a conditional object spread, an `in` question over a list, a dictionary
holding a block under a reference key, and `function*`/`yield*` — are described
under "Where the self-build stands" and have small regressions in
`test/self-build-regressions.test.ts`. A new refusal is still a reason to teach
the language or the value model, never to rewrite the source.

## The next slices

In the order they block rung 4:

1. **An object the file returns whole.** A compiled function cannot read a
   module object by name; the literal at the name is the use, but inlining it
   must not stop the constant tables (a membership question, a bracket read,
   `Object.hasOwn`) reading the keys the declaration wrote. Module constants
   now inline whole, including quoted keys and nested literals; a general
   reading for an object a function returns is still open.
2. **The remaining host services.** The native adapter carries the file,
   process, clock, path, command, environment, random, hash and text
   services, and `process.execPath` is among them now. What is left is the wasm
   host's Node entry, and any service the compiler sources ask for that the
   adapter does not yet answer.
3. **The value-model residuals.** A function reference written directly in a
   program body (a bare code address rather than a closure) is not a value a
   field holds; an empty list in a field and a list stored in a dictionary
   still have layout edges; and a value whose type is an intersection with a
   union is still read as the whole union.
4. **The self-build project.** `src/compiler/blaze.toml` names the entry
   (`cli.ts`), the host mappings (`#host/model`, `#host/platform` and
   `#host/toml`) and the machine output. It needs the toolchain services a
   build uses (`cc`, `as`, `ld` and `nim` when asked), atomic writes to
   `.blaze/`, and a decision on the fingerprint: read the installed sources at
   run time, or embed the fingerprint at build time.
5. **The fixed point test.** Node builds stage 1, stage 1 builds stage 2, and
   stage 2 builds stage 3. Compare the three on the conformance corpus:

   - exit status, stdout and stderr of every command;
   - the IR text (`blaze ir`) for every function of every fixture;
   - the build record, the selected candidate and the delivered program's
     output;
   - the program built from a fixture, run on its own toolchain.

   Add a deliberate failure case too: a source the frontend refuses must be
   refused by all three with the same message and detail.

Exit criterion for rung 4: `blaze-1` builds a program, then the compiler, from
a clean checkout; the fixed point test then compares stage 2 and stage 3.

## What is not in scope for the first fixed point

- Compiling `test/` and `bench/`. They are not part of the binary and their
  oracle is `node:test`, which the native runtime does not need to carry.
- `blazeup` and `src/optimizer`. They are a separate package and a separate
  program.
- Every model provider. The native compiler needs no model transport at all:
  a build that compiles the compiler runs the rules alone. Provider review,
  including replay fixtures, stays an optional input to a build.
- Incremental builds, if a self-build can be made deterministic without them.
  They are a performance feature, not a correctness one, and the first fixed
  point may run with `--recompile`.
- Performance. The native compiler may be slower than Node at first. The goal is
  the same answer, not the same speed.

## How progress is measured

The measure that matters is a native compiler compiling the compiler. The gap
report from `test/self-host-gap.ts` is a diagnostic for that work, not a target
or a budget: it answers three questions at once:

- how many constructs the frontend still refuses, grouped by the reason it
  gives;
- which sources are read cleanly, so a slice that fixes one module is visible;
- whether a change made the subset smaller while fixing one program.

A source is not "supported" because a sample of it compiles. It is supported
when the whole module is read, its tests pass under the native build, and the
compiler still refuses the constructs it does not carry with the same message
it gave before.

The report reads every source as a root, links every project import, and reads
a file again with the types, values and signatures its imports bind. The second
read is the one the report counts: a construct only waiting for an import is
not a gap. A package the tree installs is measured by the test that reads the
package, not as a source of the compiler; the Node host adapters are left out
and the native adapters are measured, because those are the sources the native
binary is made of.

## Decisions

- **The host is a boundary, not a branch.** `#host/platform` selects the Node
  adapter or the native one; no compiler source names a Node module outside the
  Node adapter. The host is a set of functions, not a shaped object, because a
  function is a link edge and a shaped module value is not yet a value a body
  can read.
- **One ABI answers both hosts.** The runtime carries every service either
  tree wrote, one definition per name, and the shared signatures are the ones
  the lowerings already pass. The C, Nim and wasm hosts answer the same values.
- **Module values cross by getter or by inlining.** A written constant is
  inlined; state and constructed values are read through a getter; a re-export
  follows the chain to the declaring module. An object returned whole is still
  open (slice 2).
- **Whole numbers are fixed-width.** `bigint` is a 64-bit whole until a file's
  literals pass it, then a 256-bit one; the contract evaluator holds it as a
  sign-and-magnitude value so the wraps, shifts and comparisons keep the sign
  the source gives them. A computed value of a narrower whole type beside a
  wide one is refused with the kernel's message; a written choice of numbers is
  widened in both arms. `BigInt(text)`, the wraps and signed comparisons, and
  `Number(bigint)` are answered by the C and machine backends; a wasm host
  service for the last is still open.
- **A bool is not a number in a contract.** `result == true`, not `result == 1`.
- **The text codecs are markers.** `TextEncoder`/`TextDecoder` are tracked at
  compile time; their values are the zero they hold and never a contract type.
- **Refusals are the queue.** A gap in the frontend or the IR is reported with
  a reason and a remedy. The report's count is a diagnostic for the queue, not
  a budget: progress is a native binary compiling the sources, not a smaller
  number in a table.

## Where the self-build stands

The gap report reads all 107 compiler sources whole with zero refusals, so
`test/self-host.test.ts` passes; the tests and benchmarks are outside the
binary. The contract and IR phases read the functions
that used to stop a self-build — `verifyCandidate` and the wasm backend's `Body`
methods among them — and the fixes have small regressions in
`test/self-build-regressions.test.ts`. These slices have landed:

- the contract evaluator holds integers in a sign-and-magnitude 256-bit value,
  with the wraps, shifts, comparisons, reductions and the exact
  double-to-integer conversion the language gives them;
- `structuredClone` is a deep copy in the IR and in both runtimes: records by
  their descriptors, slices by their element type, dynamic arrays and objects;
- `pop()` as a value, a push in an optional chain or a callback body, recursive
  arrows and mutually recursive walkers are read;
- module constants are inlined whole, including quoted keys, nested literals,
  tables that name other constants, and constant lists walked by `for..of`;
- `encodeURIComponent`, dynamic `BigInt(number)`, `Math.log`, `Math.pow`,
  `Math.sign`, `posix.extname`, `process.execPath` and a three-part
  `posix.join` are services the natives carry;
- caches that were module-level promises or WeakMaps moved onto the value that
  owns them (the type table holds its expansions), so no compiled function
  reads those as module state;
- a module value built by a call is read through a lazily initialized getter:
  the first read writes the value into a named state cell and marks it, every
  later read answers the cell, and a function reads the getter rather than a
  module name. The host-service and runtime-ABI tables are literal sources, so
  the wasm backend's host services are constants rather than derived state;
- contract, call-graph and IR values whose TypeScript type is a union of
  records are read by key rather than by member: a reference with no shape
  cannot choose between arms that share a field name, and the type text,
  contract phase, call graph and semantic IR now use the keyed read the IR
  already uses for a dynamic object;
- deep freezing moved behind the host boundary (`freezeValue`): the Node
  adapter keeps contracts immutable and a compiled binary, which has no freeze
  state, treats the call as a no-op;
- the type rules agree with the value model: a reference written without an
  element is the unshaped `ref<any>` whether its `of` field is absent or null,
  and a value the runtime holds is read as the text, number or truth it is
  compared with; the comparisons ask the same conversion rules an assignment
  asks. A counted loop's index is in scope in its bound and its step in the
  object pass, the frontend reduction and the IR validator, and an arrow's
  boxed capture selects the declaration of the name in the scope the arrow
  stands in;
- handles are resolved across the boundary: a raw pointer carried as a double,
  a dynamic handle at a named-reference cast, a handle in the JSON record walk
  and the SHA-256 digest, the `typeof` answer for null and for a handle, and a
  state cell's whole tagged value. Wrapper symbols are registerable as
  externals without entering the public ABI table;
- `structuredClone` of a source held behind a handle is boxed and answered as
  tagged values, and a wide module value crosses the host boundary as its
  decimal text;
- module state cells lower in the machine backend, whole-number results keep
  their exact value and sign across the boundary, and the wasm backend names a
  parsed value's kind and decodes listing opcodes by their hex spelling;
- a member read through a cast to a declared type keeps the field's type: the
  layout name a cast carries is read down to the declaration the type table
  holds, so `Array.from` over a text field resolves where the compiler writes
  it;
- a conditional object spread writes a field the expected type does not state,
  taking that field's zero from the value the written arm gives it, including
  one whose value the read cannot type;
- `in` over a list is the bounds question, so the structural hash's sparse-array
  walk reads;
- the dictionary answers a block of elements under a reference key, so a weak
  map that holds a list of names builds;
- `instanceof` a built-in collection is answered as the other built-in classes
  are: the declared type settles it, and an untyped value is one when it is
  there at all;
- a cast to a function type keeps its shape through the handle-to-pointer read,
  so a callback read off an opaque request is called through its value;
- `globalThis` is a host object whose fields are services: `globalThis.WebAssembly`
  reads through `webAssemblyEngine` even when the source casts and brackets it;
- a name bound to an arrow is that function when read as a value, so a walker
  that hands itself to `some` does not name an unbound local;
- a function that reads a module value stays with the module — module values are
  reached through their getters, including a numeric cell — so the object pass
  can call it from the program;
- an object returned at a declared type lays out its optional fields, so two
  literals of one interface are one layout and a read through an unshaped
  reference has one offset; an object with no fields is still a byte, since a
  contract names every layout a backend has to allocate;
- a field read on an unshaped reference that many layouts hold is read by name
  through the record's descriptor (`blaze_rt_object_get_from_handle`) rather
  than guessed at a static offset;
- a method's `?` parameter is callable without the argument, `() => T` states no
  parameters, and a second `as` ends the first assertion's type so a cast to a
  function type still makes a call through the value;
- a field write on an unshaped reference goes by name as well; a `rest` function
  type is called at the arity the source wrote; a settle function passed to
  `then` is the runtime builtin; `fn.call(receiver, args)` is the call of `fn`,
  and `valueOf()` answers the value the object already is;
- an `Array.isArray` or `instanceof Map`/`Set` question narrows an untyped value
  in the branch that holds, so a recursive walker's `some` and a map's `entries`
  and a set's spread read; a number added to or compared with a text writes as
  text;
- a generator is read as the list it yields: `yield` writes one element,
  `yield*` writes every element the delegated list holds, and `Generator<T>`
  states the element type the caller walks. The JSON store's batched writes
  now read, and both backends run a generator end to end.
- a function written as a field value carries its signature into the module
  value's shape, so `const table = { fn: f }; table.fn()` is the call of the
  function the field holds; the module value's initializer is re-shaped once
  the file's signatures are known, past the shape cached before the prescan;
- a pair map's second callback parameter is the position it walks, not the
  element, so `new Map(items.map((item, index) => [item.key, index]))` writes
  the index into the value rather than adding a number to the record;
- `Object.hasOwn` on an object a function returns asks the keys the literal
  declared: a constant key is answered outright and a dynamic key is the
  comparison against each declared key;
- a folded equality or `Array.isArray` truth carries its boolean marker, an
  absent conditional arm takes the present arm's type, a wide shift count
  narrows to the machine word, a wide result converts at a number return, and
  a byte block passes where a file text is expected.

The object layout pass and the C driver build: both read their statements,
shapes, calls, callbacks and request records through keyed reads, and the
verifier reads its run results the same way. Inside `toolchain/ir-wasm.ts` the
module's function lookup, the body's scopes, parameters, program calls, locals
and carrier facts build, and the next local gate is the body's value emitter.
The frontend gate is clear: `test/self-host.test.ts` passes with 107 sources
and zero refusals, and `test/self-host-ir.test.ts` resolves every compiler
contract into IR. The **validation gate is clear too**: all 7735 contracts
of the self-build resolve into IR and pass `semanticFunctionProblems` with no
problems. Every mismatch found along the way has a regression in
`test/self-build-regressions.test.ts`, `test/ir-c.test.ts` or
`test/language-features.test.ts`.

The contract representation no longer duplicates the module graph. The object
pass writes one whole-program layout table into every function definition; in
memory that is one shared reference, but JSON has no sharing, so the stored
contract was ~7.35 GB of repeated tables (21 GB pretty-printed). `core/contract-store.ts`
now keeps the layout and tag tables once at the program level, leaves each
definition without them, and writes them back by identity on read — every
consumer still sees a self-contained function. The whole self-build contract
is now about 79 MB of compact JSON (~1 GB in the pretty-printed store), down
from 7.35 GB (21 GB in the store). `test/contract-store.test.ts` holds the disk
form, the round trip, a function named `__proto__`, and backward compatibility.

The build has not completed, and fixed point is not verified. What remains is
scale in code generation: `consoleReporter` returns a closure, which the
machine backend cannot carry, so the whole program falls back to the C backend;
the C driver then compiles thousands of functions one at a time. Resolving and
validating all functions also takes hours. The fixed-point test
(`test/fixed-point.test.ts`) is in place and opt-in; its build timeout and the
self-build project's single benchmark iteration are set for that long build.
Closing rung 4 needs closures in the machine backend, or a way to generate the
whole program without one C compilation per function — both compiler changes,
not changes to the source the compiler reads.

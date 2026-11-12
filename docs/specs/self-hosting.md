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
| 2 | `blaze build --model replay` on a library | code generation, the assembler, the linker and spawning a toolchain |
| 3 | `blaze build` on a program | the program body, the runtime and running the delivered binary |
| 4 | `blaze build` on `src/compiler` | the whole compiler, including its own module graph |

## Where the source stands

The measured tree is 97 compiler sources, and the frontend reads all 97 whole:
`test/self-host.test.ts` reports **0 refusals**. The sources are already written
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
project maps `#host/model` to the replay transport and `#host/platform` to the
native adapter.

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

### The next refusal

`blaze ir` on `src/compiler` now contracts the whole module graph and stops at
`semantics/contract.ts` on `BigInt`. The contract evaluator reads a literal's
digits with `BigInt(token.text)` and wraps with `BigInt.asIntN`/`asUintN`; the
language has whole numbers of 64 and 256 bits, but no constructor from a
runtime text and no signed wide carrier.

The width question is the hard half. The language's `bigint` is held at the
machine word until a file's literals reach past it, then at the unsigned
256-bit number. The evaluator's integers are signed and can reach the top of
the 256-bit range: a span is negative, `BigInt.asIntN` produces negative
values, and `asUintN` may produce the whole unsigned range. A `u256` carrier
compares unsigned, so `span < 0n` is false for a negative span held as its
complement, and `asIntN`/`asUintN` cannot answer what they answer in the
source. The slice is a signed wide carrier for the language's `bigint` (the
`i256` primitive the contract type table already names), chosen where a file
holds signed values, with the constructor, the wrap and the comparisons read at
it. `Number(bigint)` also needs a wide-to-double conversion; the whole-number
formatter already writes the decimal `strtod` reads back, so that is the
conversion to add rather than a cast through the low word.

The next language slice is `structuredClone`, which `compiler.ts`,
`codegen.ts` and `semantics/repair.ts` use to copy an IR tree before a pass
rewrites it. A compiled function has no deep-copy service. The slice is a clone
over the runtime's values: a dynamic object and a dictionary copy their
entries, a list copies its block, and a laid-out record copies its fields at
the layout it already has.

## The next slices

In the order they block rung 4:

1. **The contract evaluator's integers.** `BigInt(text)`, `BigInt.asIntN` /
   `asUintN`, signed comparisons and `Number(bigint)`, so `semantics/contract.ts`
   builds. This is the current blocker.
2. **`structuredClone` over the runtime's values.** Records, dictionaries and
   lists, so `compiler.ts`, `codegen.ts` and `semantics/repair.ts` build.
3. **An object the file returns whole.** A compiled function cannot read a
   module object by name; the literal at the name is the use, but inlining it
   must not stop the constant tables (a membership question, a bracket read,
   `Object.hasOwn`) reading the keys the declaration wrote. The evaluator's one
   such site answers the literal; a general reading is this slice.
4. **The remaining host services.** The native adapter carries the file,
   process, clock, path, command, environment, random, hash and text
   services. What is left is `process.execPath` in `codegen.ts`, the wasm
   host's Node entry, and any service the compiler sources ask for that the
   adapter does not yet answer.
5. **The value-model residuals.** A function reference written directly in a
   program body (a bare code address rather than a closure) is not a value a
   field holds; an empty list in a field and a list stored in a dictionary
   still have layout edges; and a value whose type is an intersection with a
   union is still read as the whole union.
6. **The self-build project.** `src/compiler/blaze.toml` names the entry
   (`cli.ts`), the host mappings and the machine output. It needs the
   toolchain services a build uses (`cc`, `as`, `ld` and `nim` when asked),
   atomic writes to `.blaze/`, and a decision on the fingerprint: read the
   installed sources at run time, or embed the fingerprint at build time.
7. **The fixed point test.** Node builds stage 1, stage 1 builds stage 2, and
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
- Every model provider. The native compiler needs the replay path and one HTTP
  transport; the rest can stay behind the Node adapter until later.
- Incremental builds, if a self-build can be made deterministic without them.
  They are a performance feature, not a correctness one, and the first fixed
  point may run with `--recompile`.
- Performance. The native compiler may be slower than Node at first. The goal is
  the same answer, not the same speed.

## How progress is measured

The only useful measure is the gap report from `test/self-host-gap.ts`. It
answers three questions at once:

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
  open (slice 3).
- **Whole numbers are fixed-width.** `bigint` is a 64-bit whole until a file's
  literals pass it, then a 256-bit unsigned one. A computed value of a narrower
  whole type beside a wide one is refused with the kernel's message; a written
  choice of numbers is widened in both arms. A signed wide carrier is the next
  integer slice.
- **A bool is not a number in a contract.** `result == true`, not `result == 1`.
- **The text codecs are markers.** `TextEncoder`/`TextDecoder` are tracked at
  compile time; their values are the zero they hold and never a contract type.
- **Refusals are the queue.** A gap in the frontend or the IR is reported with
  a reason and a remedy; the report's count is the budget, not a target.

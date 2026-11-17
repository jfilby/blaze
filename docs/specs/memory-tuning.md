# Memory tuning for builds

## What this is

This spec records where a `blaze build` spends memory, measured on this tree,
and an ordered list of places to reduce it. It is a research note: it describes
the compiler as it stands and does not change it. Anything below that proposes
a change is a proposal, not a decision.

The pipeline this describes is the one in `compiler.ts`: source is read whole,
contracted, resolved into semantic IR, reviewed by a model (optionally), lowered
to a target, reviewed again, then compiled and linked. At each stage whole
artifacts are materialised as strings or object trees, and several stages keep
their output alive while the next one runs.

## Measured baselines

Peak resident memory was read from the process's own `VmHWM` high-water mark at
exit (a preload that reports `/proc/self/status` on `process.on("exit")`). A
shell-side sampler under-reports short-lived peaks and was not used for these
numbers.

| Scenario | Peak RSS |
|---|---|
| Bare Node process | ~43 MB |
| After importing `ai/review-node.ts` (the AI SDK stack) | ~143 MB |
| After importing `compiler.ts` | ~168 MB |
| Offline build of a ~1 KB program (`offline-build.ts`) | ~171 MB |
| `blaze build` of that program, no model configured | ~199 MB |
| `blaze ir` on the compiler's own 106-source module graph | **~1.9 GB** |

Two facts follow from the table.

1. **There is a ~100 MB startup floor** paid before any compilation, from
   statically importing the AI SDK stack.
2. **The large-program peak dwarfs the small-program one.** At the end of the
   1.9 GB run, `process.memoryUsage().heapUsed` was only ~40 MB, so the peak is
   dominated by short-lived allocation churn during parsing and analysis, not
   by long-lived retained state. The process sets no `--max-old-space-size`, so
   this sits under Node's default heap with no guard. Only generated child
   programs are bounded (2 GB heap, 32 MB output, 64 MB for the HTTP prelude).

## Where the memory goes

### 1. Frontend whole-graph analysis — dominant for large programs

`semantics/module-graph.ts:998-1050` reads and analyses every module, keeping
each `ModuleRecord`'s full `source` string and its `analysis` (type tables,
classes, imports) for the whole build. At `:1165-1214` every module that imports
types, classes or values is **read a second time** with the linked context and
its analysis replaced, so two analyses and all cross-module binding tables are
live during the second pass. The contract phase additionally holds the full
source text of every module (`semantics/program.ts:66-67,722`) and deeply freezes
the whole contract graph (`:719`). For a program that imports the whole compiler
this is the entire source tree plus its AST and type data in one heap.

Two specific amplifiers:

- `util/source.ts:53-79` `scan()` pushes one array entry per character and then
  joins. It is called for every program source through `runtime/http-needs.ts`
  and `runtime/sqlite.ts`, and on the array of all full source texts at
  `compiler.ts:2214-2217`. This is per-character transient allocation over the
  whole source tree.
- The program IR is resolved twice when there is a program body:
  `compiler.ts:1074` for whole-element arithmetic and `compiler.ts:2099-2100`
  via `resolvedDriver()`.

### 2. AI SDK loaded unconditionally at startup

`ai/backend.ts:32` statically imports `#host/model`, which maps to
`ai/review-node.ts:12-16` importing `generateText` and all four provider
factories. Every invocation pays the ~100 MB, including no-model builds,
offline builds and the self-build, for which no model is a first-class path
(`docs/specs/self-building.md:69-76`).

### 3. Prompts and answers held during review

`ai/review.ts:460-542` builds one prompt from the full artifact string, an array
holding it, `renderContract()` (`JSON.stringify(..., null, 2)`),
`renderProgram()` (all other functions), the rewrite catalogue and the answer
format, then joins the sections. At the join the artifact exists in at least
three forms. A `ReviewRequest` also carries the whole `ProgramContract`, every
resolved function, and optionally a full prior IR
(`ai/review.ts:52-80`, built at `codegen.ts:1450-1467`).

Retries duplicate the prompt: `ai/review-node.ts:180-193` keeps `system`,
`user` and the full text of every unreadable answer in `answers[]`, and calls
`buildRetryPrompt(user, reasons)` (`ai/review.ts:581-593`) which concatenates the
whole user prompt again. `ai/commandcode.ts:194-252,397` serialises the entire
prompt into one JSON request body and accumulates the full streamed reply.

Concurrency multiplies all of it. `candidateConcurrency` (default 4,
`codegen.ts:1428-1508`) times `functionConcurrency` (default 3,
`compiler.ts:2508-2531`) allows about twelve reviews in flight, each with its
own IR tree, printed artifact and prompt (`core/types.ts:329-337`). The
`MachineQueue` intended to serialise measurement is currently a no-op
(`codegen.ts:392-400`).

### 4. Record serialisation and whole-tree deep copies

`compiler.ts:2540-2598` `record()` deep-copies all candidate, verification,
benchmark and generation data with five separate
`JSON.parse(JSON.stringify(...))` calls (`:2580-2583,2589`). Each clone
materialises the source structure, a serialised string and a parsed copy at
once. `record()` is called once per repair round (`compiler.ts:2627-2629`), so
with N rounds the cycle repeats N times while the originals stay in
`generatedByFunction` and the incremental record. `core/json-store.ts:25-27`
then pretty-prints the whole value again on every write, and `:33-35` does
another `JSON.stringify` to hash it.

IR trees are also copied and re-printed repeatedly:
`structuredClone` per proposal (`semantics/repair.ts:199`), per candidate
(`codegen.ts:1376`, `compiler.ts:3307`) and in optimization checks
(`compiler.ts:1262`); the 8-round optimizer clones callees
(`semantics/optimize-ir.ts:3857-3984`, `semantics/restructure.ts:534,642,756-767`);
and the same candidate text is parsed and printed several times per path
(`codegen.ts:645-672,886,906,1496,1555`).

### 5. Fingerprinting reads the whole source tree, every build

`core/version.ts:122-152` `fingerprintSources()` loads every `.ts` file in the
package into a `Map<string, string>` (`:123,134`), then builds another
concatenated string per file with `hash.update(\`${path} ${contents} \`)`
(`:149-150`). It is called unconditionally at `compiler.ts:1948`. The comment at
`version.ts:155-162` deliberately rejects a process-wide cache, so the full read
and hash repeat each build.

### 6. Child processes buffer all output

`core/process.ts:70-71` sets a 32 MB default buffer and `:96-105,130-146`
retains each child's entire stdout and stderr as strings in every `RunResult`.
`core/platform-node.ts:149-168` uses `spawnSync` with `encoding: "utf8"`, so
there is no streaming for compiler subprocesses. `runAsync()` is only
`Promise.resolve(run(...))` (`core/process.ts:166-172`), still synchronous.
Vector and benchmark input is also built whole (`toolchain/verifier.ts:487-517`,
`toolchain/benchmark.ts:72-80`).

### 7. Other whole-file and retained-state costs

- `codegen.ts:1264-1281` `targetArtifact()` re-reads the whole deliverable on
  every winner review; `describeMachineObject` (`toolchain/ir-machine.ts:13004-13010`)
  spawns `objdump` and keeps its full stdout. The SQLite amalgamation is read
  whole at `runtime/sqlite-build.ts:460`.
- `ai/backend.ts:233,240-281` `ReplayBackend.load()` reads and parses the whole
  replay file, and a fresh backend is built per function (`compiler.ts:2379`),
  so several full copies can be in flight.
- Build state (`reusedByFunction`, `awaitingProgram`, `generatedByFunction`, the
  incremental record) lives for the whole build, and the incremental record is
  shallow-copied whole on each verified function (`compiler.ts:2477`).
- `incremental.ts:231-247` `unitKeys()` hashes the contract via `JSON.stringify`
  per compilation unit (`compiler.ts:2192-2209`).

## Priorities

Ordered by expected memory saved against implementation risk.

1. **Lazy-load the model transport, and import only the configured provider.**
   Removes roughly 100 MB from every no-model, offline and self-build; lowest
   risk because the no-model path is already a supported mode.

2. **Tighten prompt and answer retention and bound concurrency.** Release
   artifacts after use, avoid rebuilding the full prompt on retry, cap response
   size locally, and bound in-flight candidates by a memory budget rather than
   a fixed product of two concurrency knobs.

3. **Reduce whole-file reads and buffered child output.** Stream or redirect
   subprocess output, and defer reading large artifacts such as object files and
   the SQLite amalgamation until needed.

## Validation

Any change from these priorities should be checked against the existing tests,
in particular `test/self-host.test.ts`, the build-record determinism checks, and
the heap-bound tests in `test/verifier.test.ts` and
`test/program-body.test.ts`. The self-hosting spec currently treats performance
as out of scope for the fixed-point goal (`docs/specs/self-building.md:233-235`),
so correctness and determinism take precedence over memory savings here.

Peak RSS should be remeasured with the same in-process `VmHWM` method described
above; a shell-side sampler is not reliable for short-lived peaks.

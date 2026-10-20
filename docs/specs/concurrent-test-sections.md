# Spec: Run sections of the full test suite concurrently

## Goal

The full compiler test suite (`npm test` in `src/compiler`) takes over ten minutes
and blocks work on the compiler. Run **sections of the suite concurrently** so a
full run finishes much faster, and so a single section can be run on its own.

A "section" is a runnable slice of the suite — a whole test file, or a named
subset of one test file's tests. Sections are independent, so any group of them
may execute at the same time in separate processes without interfering with one
another.

## Why this matters

The suite's cost is not spread evenly. Standalone (uncontended) timings on the
4-core build host show a few files dominate:

| file | standalone time | tests |
|---|---|---|
| `test/ir-machine.test.ts` | ~165s | 64 |
| `test/u256.test.ts` | ~145s | 23 |
| `test/http-facilities.test.ts` | ~139s | 8 |
| `test/http-end-to-end.test.ts` | ~126s | 15 |
| `test/program-body.test.ts` | ~119s | 83 |
| `test/runtime.test.ts` | ~101s | 24 |
| `test/build.test.ts` | ~67s | 47 |
| everything else | fast (most under ~2s each) | ~790 |

Within `node --test`, each **file** runs in its own process but every test in a
file runs one after another. The dominant files are therefore long poles no
matter how many files run in parallel: even infinite file concurrency cannot go
below the cost of the longest file (~165s). Splitting a heavy file into named
sections lets its tests run in parallel too.

Baseline numbers measured on this host:

| invocation | wall time | max RSS |
|---|---|---|
| `npm test` (baseline) | 629s | ~1GB |
| `--test-concurrency=8` | 390s | ~2GB |
| `--test-concurrency=12` | 350s | ~1.7GB |
| `--test-concurrency=16` | 446s (slower: memory pressure) | ~2.1GB |

Running the whole suite as ~200 name-pattern sections (one `node` process each)
was tried: it **OOM'd the machine**. Concurrency must be bounded, and memory
must be watched. A good target is a bounded pool sized to the host (4 CPUs),
which keeps each section's module import cost from being multiplied out of
control and leaves memory headroom for the compiler tools each test spawns
(gcc, objdump, curl, node, etc.).

## Required changes

### 1. A sectioned test runner

Add `src/compiler/test/run.ts` (and supporting code in `test/sections.ts`):

**Sections**
- Discover every `test/*.test.ts` file.
- For each file, enumerate its `test("name", ...)` declarations statically with
  the TypeScript compiler API (`typescript` is already a devDependency), so no
  test body is executed during discovery. The declaration count feeds the TAP
  plan.
- Each file is one whole-file section. Per-file name-pattern sharding
  (running each test as its own section via `--test-name-pattern`) was
  evaluated, but every section re-imports the compiler (~2.5s per section), so
  the import cost multiplies across the suite and runs slower overall on this
  host. Whole-file sections with a bounded pool give the best wall time and the
  simplest, most accurate progress reporting. The name-enumeration code is kept
  so per-test sharding can be added later if tests become slow enough to
  amortize the import cost.
- Name patterns (if re-introduced) use anchored regexes with escaped
  metacharacters so names containing `.` `( ) * + ? [ ] { } | ^ $ \` match
  exactly one test.

**Concurrency**
- Run whole-file sections in separate node processes through a bounded pool
  (concurrency flag, default 8). Pool by section so long sections run alongside
  short ones.

**Output**
- Merge every section's TAP into one coherent TAP document:
  - one `TAP version 13` header and one `1..N` plan,
  - one set of `# tests / # pass / # fail / # cancelled / # skipped / # todo /
    # duration_ms` summary lines (aggregate across sections),
  - a final exit status of non-zero if any section failed.
- Preserve the existing progress output: every tenth of the sections done, as
  the current `test/reporter.ts` does, said over the suite's own output.
- Keep the contract the optimizer (`src/optimizer/cli.ts runTestSuite`) reads:
  `^# pass (\d+)$` and `^# fail (\d+)$` once each in the combined output, and
  the process exit status settles pass/fail.

**Entry point**
- Change `scripts.test` in `src/compiler/package.json` to run the sectioned
  runner instead of the bare `node --test test/*.test.ts`, e.g.
  `node --test-reporter=./test/reporter.ts ./test/run.ts test/*.test.ts`
  while keeping `--test-reporter=./test/reporter.ts` present (the existing
  `reporter.test.ts` asserts on it).

### 2. Keep it correct

- No test file may be edited to make a test pass; sections run the identical
  tests the suite runs today, only grouped and scheduled differently.
- Concurrency must be bounded to avoid OOM (the 200-process experiment
  exhausted memory). Watch RSS; default pool size small.
- Sections that share fixed ports must not collide: `http-end-to-end.test.ts`
  (ports 18080-18091) and `http-facilities.test.ts` (ports 18100-18107) bind a
  distinct port per test, so name-sharding within those files is safe because a
  test never shares its port with another test of the same file. `chatEndpoint`
  uses port 0 (OS-assigned).
- Do not run unbounded name sharding of every file: module import cost and
  gcc/objdump spawns multiply with every process.

### 3. To-dos

- [ ] Write `src/compiler/test/sections.ts`: file discovery + static test-name
      enumeration, section planning.
- [ ] Write `src/compiler/test/run.ts`: bounded pool, section execution,
      TAP merge, aggregate summary, exit status.
- [ ] Update `src/compiler/package.json` `scripts.test`.
- [ ] Add a test for the runner/sections (test file discovery, name escaping,
      summary aggregation).
- [ ] Measure before/after: confirm wall time drops well below 629s with the
      default bounded pool and no new failures compared to the 35 pre-existing
      ones.
- [ ] Confirm `--test-reporter=./test/reporter.ts` still drives progress and
      `reporter.test.ts` still passes.
- [ ] Confirm `runTestSuite` in `src/optimizer/cli.ts` still parses the
      combined output correctly.

## Constraints from AGENTS.md

- Do not edit example or benchmark programs.
- Do not edit env files; do not look in archived files.
- Do not create or edit anything under `private-docs`.
- Do not rewrite strings from programs to versions that work; add support to
  the compiler for the original form instead.
- Do take care not to cause an OOM with benchmarking and testing.
- Do edit compiler tests if they're not correct.

# Instructions

## Project

This is Blaze, an AI compiler to generate assembly from traditional source.


## Layout

`src/compiler` is the npm package: manifest, lockfile, tsconfig, sources and
tests all live there. Run commands from it.
- `npm run typecheck`, `npm test`, `npm run aic -- <args>`
- A program becomes the semantic IR (`core/semantic-ir.ts`) before any target
  code exists: `semantics/ir-resolve.ts` and `ir-function.ts` write it from the
  source, `ir-validate.ts` checks it, `ir-text.ts` prints and reads it, and
  `blaze ir` shows it.
- Two axes say what a build does, and they are separate. `output` is how far
  the IR is carried: `ir` delivers it as written, `c` emits it as C, `asm` and
  `machine` as assembly and an object, `wasm` as a WebAssembly module.
  `backend` is what writes the artifact, named for what the compiler itself
  emits — `c` for the C that `gcc` finishes, `wasm` for a module
  (`toolchain/ir-wasm.ts`) and `machine` for an object
  (`toolchain/ir-machine.ts`, over the encoder in `toolchain/x86.ts` and the
  object writer in `toolchain/elf64.ts`) that the compiler encodes itself and
  no toolchain touches. A project names neither and gets the pair the output
  kind implies; what each backend can deliver is the table in
  `compiler.ts:BACKEND_DELIVERS`, so a pair that cannot be built is refused
  where the input is read. Everything is lowered on the one path in
  `codegen.ts:materialize`, and the backend is in the reuse key
  (`incremental.ts`) so an object is never shared across one.
- A build record names the engine that built it (`core/version.ts:engineStamp`):
  the release and eight hex digits of the review fingerprint, which is a hash
  of the compiler's own sources. It moves when anything that decides what a
  function is moves, and a run that finds a different stamp announces it
  before spending anything — the whole cache is invalidated at once, so the
  user is asked on a terminal and the announcement is printed when there is
  nobody to ask. Answering no throws `CancelledError` before the record is
  written, so a declined build leaves the last one as it was;
  `blaze build --recompile` is the same answer given in advance, and rebuilding
  on an engine change is what the announcement promises, so it discards what
  was stored even where the reuse keys would have let it through.
- A third setting says how hard the toolchain builds. `mode` is `debug`
  (`-O0 -g`, the default), `release` (`-O3`, or `-O2` where the contract asks
  for `size`), or `danger` (release, and the generated runtime leaves its guards
  out). The flags are one list in `core/target.ts`, split into
  `optimizationLevel` (the `-O` and the maths), `loweringOptions` (that with
  `-flto`, which the deterministic lowering and the link both read),
  `assemblyOptions` (the level alone, because `-flto -S` writes the linker's
  intermediate form and not assembly) and `linkOptions`; every `gcc` call site
  reads one of them, and each link site is given the contract's objective and
  the target cpu, because with `-flto` the link is where the code is generated.
  `danger` removes the use-after-free check, the allocation overflow check, the
  size caps and the null checks from `runtime/abi.ts` and its twin in
  `runtime/nim.ts`, which are the only run-time safety checks a
  generated program carries: there is no bounds check on an element access at
  any mode, because the IR holds no length for one. What the compiler *proves*
  is unchanged — the IR is validated and the candidate verified and measured
  the same way in all three.
- A model never writes a program. It is asked twice per function to read an
  artifact the compiler produced — the IR, and the target the IR was lowered
  into — and to answer with a verdict and a list of proposals naming rewrites
  out of `semantics/repair.ts` (`core/proposal.ts` is the grammar, `ai/review.ts`
  the prompts, `ai/backend.ts` the transports). A proposal the rules hold is
  applied by rewriting the IR and printing it again; one they do not is refused
  with a reason, which the build log and the next review both carry.
- `maxCandidates` reads are one reading, not several copies of it. Every chain
  starts from the same base IR, so without something to tell them apart the
  first round of every candidate rendered the same prompt and a build paid for
  N calls to learn one thing. What differs is a *reading* — where to start
  looking, one per rule in the catalogue and then a catch-all, assigned by
  candidate number — not a rule: every rule stays open to every candidate, so a
  candidate sent to look at the loops may still propose an inline, and one that
  finds nothing where it was sent answers `sound` and the build moves on. The
  prompt states which candidate of how many it is, which is what keeps a build
  with more candidates than readings from repeating one; a build that asked for
  a single candidate is told nothing, there being no other reading to differ
  from.


## Libraries

Make use of:
- Vercel AI SDK


## Design notes

- Move complexity down where possible.
- Pass data structures instead of using private fields to improve determinism.
- If you need to add features to the compiler, aim for correctness over speed
of implementing those features.


## List of do's

- Do take care not to cause an oom with benchmarking and testing.


## List of dont's

- Don't try to do anything that would require secrets you don't have.
- Don't edit env files, ask the user to do this for you.
- Don't look in archived files, they are assumed to be irrelevant.
- Don't edit anything under the private-docs dir.


## Specs

The compiler's stages are:

<1. original source, e.g. TypeScript>
  -- rule-based transform -->

<2. IR>
  -- LLM verification and proposed fixes -->

<3. verified/revised IR>
  -- rule-based transform -->

<4. target low-level code, e.g. ASM, WASM, machine code>
  -- LLM verification and proposed fixes -->

<5. verified/revised target low-level code, e.g. ASM, WASM, machine code>
  -- compile -->

<6. binary>


LLMs are used to verify both IR and low-level targets. They do not implement
fixes themselves. Instead, they inspect an artifact and propose fixes. The
rule-based compiler evaluates those proposals and, when they are valid, applies
them by regenerating the artifact.


## The rules a review may propose

`semantics/repair.ts` is the whole vocabulary: `hoist-invariant`,
`common-subexpression`, `reciprocal-multiply` and `inline-call`. Each is a
rewrite of the semantic IR, so what a rule produces is a program the compiler
wrote and every validator, printer and backend already reads.


## Rule-based code transformers

These are deterministic and tested, but actually generated by LLMs as part of
building the compiler.

`semantics/whole-numbers.ts` is the one deterministic rewrite that is not a
rewrite of a single body: it reads a whole program, because what it needs to
know is what the *callers* of a function hand it. A function whose every caller
passes whole numbers at every parameter has whole-number parameters, whatever
the source declared them as, so its arithmetic can be computed in whole numbers
instead of in doubles — and on the spectral-norm example that is the difference
between 133 ms and 64 ms at n=1000, which is where a build whose counters are
`int` already was. Whole-number arithmetic is only the same arithmetic while
every intermediate is under 2^53, and the IR holds no bound on a loop counter,
so the body answers the whole-number form only inside a reach it tests its own
arguments against, and keeps the arithmetic the source wrote outside it.

## Benchmarking

You can use hyperfine to benchmark a program or more than one at a time. E.g.:

```sh
hyperfine --warmup 3 ./binarytrees_machine ./n2
```

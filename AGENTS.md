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

That vocabulary is the whole of what a review may propose, and it is
deliberately not a rule that parallelises a loop. The rules above each rewrite a
program into the same program written differently, and a program written
differently is one the validator can refuse if the rewrite was wrong. A
parallel loop is the same *outcome* reached by a different *execution*, and
whether it is the same program depends on a proof about what two turns may
touch — which is `semantics/parallel.ts`, and which is not something a
proposal can carry.


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

`semantics/parallel.ts` marks the loops whose turns do not depend on each other,
so a backend may run them at the same time on more than one thread. It is the
one rewrite whose answer is a *proof* rather than a cheaper form of the same
program: a turn may run beside another exactly when neither writes anything the
other reads or writes, so a body that writes an outer name, allocates (the
runtime's allocator is one heap with one free list), prints or calls anything is
left alone. The one write it accepts is the element named by the turn's own
counter — `out[i] = f(values[i])` is the shape nearly every loop worth
parallelising is — and any other index is refused, because the IR holds no
length and nothing could say the two turns do not name the same element. A mark
is a permission and not an instruction. The C backend takes it and writes
`#pragma omp parallel for`; the machine backend takes it and writes the turns
out as a function the runtime calls once per thread; the wasm backend runs the
turns in order, which is the same program because nothing about one turn reaches
another.

The machine backend has no instruction that starts a thread and no atomic, so
the thread is the runtime's: `blaze_rt_parallel_for` cuts the counters into as
many parts as there are processors and calls a turn once per part, which needs
no lock because each part is cut before any thread starts. A turn is a function
of its own with a frame of its own, and it reads the frame it was handed rather
than the registers of the thread it runs on — the register allocator is told
which names a turn reads and keeps them out of registers for that reason. It
refuses a loop it cannot run as a turn: one carrying an accumulator the turns
would have to combine (which is what the vector paths below are for), one whose
counter is narrower than the halves a range is cut into, and one whose body
returns, since a turn that returns returns from the turn.

A turn may also call a function, which is the case that needs the whole program
rather than one body: what a call reaches is the *callee's* body, so the analysis
is given every function of the program and reads a callee's body with the rule a
loop body is read with, unchanged. A call is refused on three things the IR
states about it — an owned result (the allocator is one heap), a retained result
(the reference count is one number every turn shares), and any effect beyond
`memory` — and on everything the callee does, transitively. So `scaled` below is
admitted because it writes only its own `acc`, and the loop calling it is
parallel; make `scaled` write anything else and the loop is refused, because a
function that is not pure cannot be run by two turns whatever asked for it.

```ts
export function scaled(x: number): number {
  let acc = x;          // its own name, so its own
  acc = acc * 1.25 + x;
  return acc;
}

for (let i = 0; i < n; i += 1) {
  output[i] = scaled(input[i]);   // marked parallel
}
```

Recursion terminates by assuming the answer and checking it afterwards, which is
the only reading that does: a function that calls itself and writes nothing is
pure, and one whose recursion reaches a write is caught where the write is.
Nothing about a function is assumed from its name or its contract — a body this
build does not hold is a body nobody has read, so a call to one is refused, and
that refusal is why `Callees` is an argument on `optimizeSemanticProgram`,
`validateSemanticProgram` and `refusalFor` rather than something looked up.

The mark is not asked of a model and cannot be proposed as a repair rule.
Independence is not something a proposal can carry, because a proposal that is
wrong about it is a program with a race in it rather than a program that is a
little slower. `ir-validate.ts` asks the same analysis about every loop the IR
*text* claims is parallel, so a mark written by hand or by a model is proved
rather than believed.

It also asks whether a turn is worth a thread. Handing `out[i] = in[i] * 2 + 1`
over four million elements to four threads measured 1.6 times *slower* than
running it in order, because the C compiler already vectorises it and the loop
is bound by the memory it moves; the same pragma over a loop whose turn computes
few hundred values measured 1.9 times faster. A turn below eight computed values
is therefore refused on cost alone, which is the one clause here that is a
judgement about speed rather than a proof about correctness.

What a turn computes *through a call* counts toward that eight, because the
thread runs the callee too. `out[i] = scaled(input[i])` writes one element and
computes two values, and counting only those would refuse exactly the shape the
purity rule exists to admit. The loop calling `scaled` above over four million
elements measured 1.38 times faster than in order.

`semantics/region.ts` is the other half of that, and it is about memory rather
than about turns. A program that builds something and then drops it takes fresh
storage for every one it builds. On binarytrees at depth 18 the pool this
compiler uses grew to a gigabyte and about three quarters of the run was the
kernel handing out fresh pages for it, because nothing the loop produced was
ever released — and a node freed one at a time would cost as much to free as it
did to build. A region is the same cursor rewound at the top of every turn, so
the next tree is written over the one just walked: measured 6.8 times faster
through the C backend and 3.8 through the machine one, with peak memory down
from 5.7 GB to 252 MB at depth 18.

The reuse is the same program only when nothing a turn allocates is still
wanted once that turn has finished, and that is what the module decides. A
block built in the turn and held only by names the turn declares is gone when
the turn ends; the same block held by a name the turn found is not. So the walk
follows the blocks the turn makes into wherever they are put, and stops as soon
as one lands somewhere that outlives it — a name it did not declare, a buffer or
an object it did not build, a reference count, a return, or a function that keeps
what it is handed. `checksum` walks a tree and answers a number, so the tree is
still the turn's afterwards and the loop calling it is admitted; make `checksum`
write the tree anywhere and the loop is refused.

A refusal costs memory and a mistake would corrupt, so the answer is a question
asked of the whole program rather than of one body: what a call does with what
it is handed is decided by reading the callee, and a body this build does not
hold is a body nobody has read, so a call to one is taken to keep what it is
given and the loop above it is refused. A function that reaches itself is read
the way the parallel analysis reads one — assuming and checking afterwards —
and `ir-validate.ts` asks this analysis about every loop the IR *text* claims is
a region, so a mark written by hand or by a model is proved rather than believed.

The mark is the word `region` beside `parallel` on the loop, and the two are
about different things: a loop may carry either or both. One loop on a path is
marked, and it is the innermost one that can be, because a rewind takes
everything the region has handed out, and a rewind inside a loop that is itself
marked would write over what the outer turn took before the inner loop began.
The loop the blocks are built in is the one whose turns pay to rewind, which on
binarytrees is the inner loop and not the one wrapping it.

The runtime keeps one region cursor per thread, for the same reason the slab
pool is per thread: the turns of a parallel loop are handed to threads of the
host's, and a cursor shared between them would hand two turns the same block.
The cursor only ever grows — a region that filled up was asked for more room
than it had — and is never copied, because a block holds pointers to the blocks
beside it and moving them would leave every one aimed at where a block used to
be. A region is entered and left around the body of a marked loop and left early
on the paths that leave the turn early, so a `break` out of the loop or a
`return` out of the function does not carry it past the turn.

`semantics/recursion.ts` answers a body's own recursion with a loop, and it runs
before the rounds in `optimize-ir.ts` because the loop it writes is the loop
they read: hoisting an invariant out of a recursion, commoning two values in it
and counting its turns are three things none of them can do while the frames are
still there. It is one pass over the IR rather than one per backend, so every
output kind lowers the loop and none of them re-derives it.

There are two shapes, and both are the narrowest that can be proved. A **tail
call** is the first: the entry block ends in `return f(args)` where `f` is the
function itself, and the statement before it is the test that ends the
recursion. Every statement around that test becomes the body of a loop, the
arguments are bound to fresh names in the order the call wrote them — which is
the order the call evaluated them in, so a body that prints keeps the print —
and the parameters are written from those names only once every argument has
been read. Nothing about the ordering of a turn changes; what is gone is the
frame between one turn and the next.

```ts
function count(n: number, acc: number): number {
  if (n <= 0) return acc;
  return count(n - 1, acc * n);   // while (!(n <= 0)) { ... n = n - 1; acc = acc * n; }
}
```

The second is a **linear recursion whose answer is accumulated**, which is the
explicit state machine a non-tail recursion is answered with when it can be: the
entry block ends in `return <something holding exactly one call of itself>`, and
that call sits at the end of a chain of `+` or `*` over whole numbers. The value
the turn before was going to hand back is held in a name, the turn combines into
it, and the loop carries it on. It is restricted to that chain because the loop
runs the turns *the opposite way round* to the recursion — the recursion nests
`E0(E1(E2(base)))` where the loop combines `E2` into `base`, then `E1`, then
`E0` — and the two are the same number only where the combination does not care
which way round it goes. `+` and `*` over whole numbers are exact however they
are grouped, the same fact the reductions in `parallel.ts` rest on. A double is
not exact that way and a subtraction is not the same operation either way
round, so both are refused rather than approximated.

What is left alone is most of the language's recursion, and that is the point. A
recursion with two calls of itself in one return — `fib`, or a tree walked with
a left and a right — is not a state machine this IR can hold: it needs storage
whose length is not known until the walk has finished, and an array in
`core/semantic-ir.ts` is allocated where the program wrote it out, at a length
the program states. There is no push and no growth, so an explicit stack of
unbounded depth is not a program this IR can be written as, and a traversal is
not answered with one that would overflow where the recursion did not. Every
refusal carries its reason and `recursionRefusal` hands it to whoever asks why a
body kept its calls.

One difference is worth stating because it is the only one: a tail call that
never reaches its base case was a stack overflow and is now an unbounded loop.
Both are a program that does not answer, and neither writes anything the other
does not.


## What the machine backend decides

The backend keeps no machine-level IR: it walks the semantic IR and writes
instructions as it goes, so every decision about a register, an address and an
instruction is one it makes while writing rather than one a pass makes
afterwards. Four of them are worth knowing about, because each of them is worth
getting wrong exactly once.

**A rounding is not a call.** `Math.floor` and `Math.round` are written as
instructions — a conversion to a whole number, and the correction that turns
dropping the fraction towards zero into dropping it towards minus infinity — and
so is the argument they are called with. A target that names `sse4.1` gets the
one instruction that rounds; a target that has not gets these, which are as
exact as the library over every double: a value above `2^52` in either
direction, a NaN and a negative zero are each their own answer, and everything
else is a conversion and a subtraction. The register allocator is told which
builtins are written this way (`INLINE_BUILTINS`), which is what lets a body
whose only call is a rounding keep its names in registers the convention does
not ask a callee to preserve.

**The order of an expression is the order the lowering writes it in.**
`semantics/liveness.ts` decides what is live across a call from the order it
reads the body in, and a name it thinks is dead before a call is given a
register the callee is free to write over. So the order there is the order in
`ir-machine.ts` and nothing else: a difference and a quotient of machine
numbers are written right side first, because the side that is not the
instruction's own immediate is written first and parked; a concatenation, a
minimum and a maximum are written left side first, because they take both
sides and then work on them; a wide product, quotient or shift is a kernel
handed both sides and writes the left one first. Getting one of these wrong is
a miscompile rather than a lost register, which is what the tests in
`liveness.test.ts` about the order are for.

**An element is addressed by the read or the write itself.** `base + index *
scale` is one address the machine has, so where the buffer is in a register of
its own and the index is in one — a counter held as a whole number beside the
double it is stepped as, a number the program wrote out, a name the allocator
pinned — an element read or written is one instruction. The general form is
still there for the cases where either side is computed, and it puts the
address in the accumulator.

**Two loops one after another may share a counter.** `for (let i ...)` written
twice in one function declares `i` twice, and the lowering writes the two
declarations as two names. They are still the same counter as far as the source
is concerned, because the first is dead before the second is bound, so one
register serves both. Two loops that are *inside* one another cannot share one,
which is the case the allocator still refuses.

## Benchmarking

You can use hyperfine to benchmark a program or more than one at a time. E.g.:

```sh
hyperfine --warmup 3 ./binarytrees_machine ./n2
```

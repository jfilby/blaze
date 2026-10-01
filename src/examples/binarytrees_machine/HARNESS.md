# Measuring a change to the compiler

`bench.sh <depth> <binary>` times a built program. The other three scripts are
how a change to the compiler gets measured against one.

## `relower.mjs`

`node relower.mjs` rebuilds this project from the candidates an earlier build
stored, lowering them through the compiler as it is now.

`blaze build` does this for an edit to the lowering and does not do it for an
edit to the review. The incremental key is two hashes: what decides the IR a
function is, and what decides the object that IR is lowered into. An edit to
`ir-machine.ts`, `ir-wasm.ts`, the assembler, the encoder or the runtime moves
only the second, so the candidates an earlier build reviewed are still what a
model reviewed, and the build puts them through the toolchain as it is now
instead of asking for them again — re-verified, re-benchmarked and re-selected,
and the choice is made afresh over every stored candidate rather than over
whichever the record held first.

An edit to `optimize-ir.ts` is on the other side of that line, and has to be. The
optimizer rewrites the IR the model is handed, so what a review said was said
about a function that no longer exists, and the record is thrown away. So is an
edit to `verifier.ts` or to the prompt: those decide whether a candidate is
valid and what a verdict is. A source is on the lowering side only when nothing
it does reaches back into the IR; a new one starts on the review side, which is
the direction that discards work rather than keeping work an edit invalidated.

`relower.mjs` is still the faster of the two, and `blaze build` is the one that
checks what it produced.

It is a harness, not a build: it links what it is given and does not verify,
benchmark or review. `blaze build` is for that.

## `cost.sh`

`./cost.sh <binary>` counts three things per function: the instructions its text
carries, the memory operands among them, and the memory operands that name the
stack pointer. RIP-relative loads are not counted, since they read a constant
the linker put in `.rodata` rather than a value the program computed.

This is the metric a change is judged on, because the wall clock cannot resolve
what these changes are worth. Two runs of one binary on a shared machine differ
by about a percent — `ab.sh` measures that floor — and the hot functions here
are memory-bound: a run at depth 16 writes about 1.2 GB of fresh nodes and
takes roughly 290,000 page faults, so an instruction removed from a function
that runs fifteen million times is invisible next to that.

The three counts are not redundant. A register-to-register move and a load out
of the frame are both one instruction, so the instruction count alone cannot
tell a value kept in a register from one left in a slot — and every change to
register allocation is exactly that substitution. Giving `checksum`'s parameter
a register leaves its instruction count at 19 and takes its memory operands from
9 to 5; what is left there is the partial sum spilled around the second call,
which is a value live across a call rather than one that was only ever read,
and no amount of pinning reaches it. The gap between `memory` and `stack` is the
traffic through a pointer — a field read, an argument — which a register cannot
remove and a change to the object layout can.

It reads the build store's copy of the binary, which keeps its symbol table;
the one delivered beside the sources is stripped, and `cost.sh` says so and
exits rather than reporting zeroes.

## `ab.sh`

`./ab.sh <baseline> <candidate> [depth] [repeats]` times two binaries against
each other, one run of each in turn, and reports the best of each. Interleaved
rather than measured a block at a time, so whatever the machine is doing affects
both; and the best rather than the mean, because the best run is the one that
had the machine to itself.

Useful for confirming that a change did not make things worse, and for judging
a change big enough to see through the noise. Build a baseline from the same
scripts at the commit before:

    git stash && node relower.mjs && cp binarytrees_machine /tmp/base && git stash pop
    node relower.mjs
    ./ab.sh /tmp/base ./binarytrees_machine 16 20

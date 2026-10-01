# Measuring a change to the compiler

`bench.sh <depth> <binary>` times a built program. The other three scripts are
how a change to the compiler gets measured against one.

## `relower.mjs`

`node relower.mjs` rebuilds this project from the candidates an earlier build
stored, lowering them through the compiler as it is now.

`blaze build --reuse` cannot do this: the incremental key hashes the compiler's
own sources, so editing the compiler invalidates every stored object, which is
exactly the edit being measured. This reads the stored IR instead, so a change
to `optimize-ir.ts`, `ir-machine.ts`, `ir-wasm.ts` or the runtime is in the
built program within a second and no model is asked for anything.

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

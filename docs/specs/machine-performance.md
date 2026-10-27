# The machine backend's speed

## What it is

The machine backend lowers a function's semantic IR to x86-64 machine code
and writes the object itself (`src/compiler/toolchain/ir-machine.ts`). This
is what it does for speed, what it costs, and what is left.

The measurements are the ones `src/benchmarks/bench.sh` takes, plus three
programs written for this work. They are not in the repository, and they are
here so that they can be written again: `loopbench` is a scalar loop, `arrbench`
is an array of doubles summed and multiplied, and `hotbench` is the scalar
loop over an array, ten million times.

| Program | What it is | Before | After | The C compiler |
|---|---|---|---|---|
| `loopbench` | a scalar loop: `for (i = 0; i < n; i++) sum += i * 2 + 1` | 7.0 ms | 2.4 ms | 2.2 ms |
| `hotbench` | the same loop over an array, ten million times | 35.9 ms | 16.7 ms | 16.4 ms |
| `arrbench` | an array of two million doubles, summed and multiplied | 35.7 ms | 20.9 ms | 20.6 ms |
| `binarytrees` | the benchmark program: recursion and allocation | 108.4 ms | 103.5 ms | — |
| `spectral_norm` | the benchmark program: 90 million divisions by a counting weight | 123 ms | 84 ms | — |

`spectral_norm` is at the speed of its divisions: 90 million of them in 84 ms
is about four cycles each on two physical cores of the machine below, which is
what the divider answers one in. The turn is eight instructions and the
divider is four of its cycles, so what is left to win there is the divider and
nothing else — which is what the AVX-512 form of the loop is for, and that form
is the reason the target on this machine does not reach it: it has no AVX-512.


The last column is `gcc -O2` on the same program, which is what the C
backend's code is compiled by. The machine backend is at parity with it on the
three programs that are arithmetic, and the arithmetic is what the backend
writes.

`binarytrees` is the one that barely moved, and the reason is worth stating
before anything else: **two thirds of it is the runtime's allocator**, not the
code the backend writes. A node of the tree costs about 24 cycles to
allocate and about 9 to walk, and the allocator is C that the C backend calls
too. The backend's own share of that program is small, which is why the
program that is *only* arithmetic moved by a factor of two and this one did
not move at all.

The allocator is at its fastest because the compiler proved the loop's
allocations are dead by the end of its turn and marked the loop as a region:
every block a turn allocates is taken from a cursor that is rewound at the end
of the turn, so the next turn takes the same storage again. The region is
entered and left by a call each, and those two calls are a fifth of a turn —
the loop is four times slower without the region, so the calls are well spent.
Making them cheaper is a matter for the runtime's ABI rather than for the
backend: the region is a pair of counters in the runtime's own memory, and the
backend cannot write them without the runtime handing them over.

## What the backend does, and why

The backend's discipline is that no value is given a register of its own by
default: every value the body computes is written to a slot in the frame, and
the registers carry a value between two instructions — the accumulator and
one scratch beside it. That is what makes a register, an offset and an
instruction the compiler's decision rather than a model's, and it is the
reason the backend can be compared against the C one instruction by
instruction.

The speed comes from taking values *out* of that discipline where the frame
round trip is what costs:

### A name the build gave a register of its own

`semantics/liveness.ts` solves where a name is live and whether a call falls
inside its live range, and the backend gives a name a register where the
census says it is worth one: a name read on every turn of a loop is read
often enough that the frame round trip of keeping it there is a load and a
store per turn.

Two things were added to that census:

- **A compound assignment reads the name it writes.** `total += x` reads
  `total` as well as writing it, and the census did not see the read. A name
  that is accumulated on every turn of a loop was therefore worth half of
  what it is worth.
- **A counter the loop reads as a number is a counter the loop reads.** The
  counter of a loop whose body reaches it only as an index is counted in
  whole numbers where the loop can be, and the double beside it is then
  nothing any turn reads. Where the loop *cannot* be counted that way — its
  bound is a number the program wrote rather than a literal — the double is
  the counter the test compares, and the test reads it on every turn.

### A conversion does not wait for what the register held

`CVTSI2SD` writes the low half of the register it writes into and leaves the
half above it as it was, so it waits for whatever last wrote there. In a loop
that is the arithmetic of the turn before, which writes zeros above the
number it works on: **a loop that converts a counter on every turn waits for
the whole arithmetic of the turn before it**, and runs at a third of the
speed it could.

Clearing the register before the conversion says the answer does not depend
on what was there, and `PXOR` is the instruction that says so — the processor
knows its answer is zero whatever the register held, so it does not wait for
the last write to it. This is the single change that took `loopbench` from
64 ms to 20 ms.

The same shape of problem is elsewhere and is not yet fixed: `CVTSD2SS` and
`CVTSS2SD` merge the half above the destination too.

### A compound assignment is written in the register the name has

The value the name is given is in the accumulator and the name's own value is
in the register, so the operation is the one instruction that writes the
register from the accumulator. The general form wrote the value down, read
the name out and read the value back out again — four instructions where this
is one, and a compound assignment is on every turn of every loop that
accumulates.

### A field is read through the register its object is in

An object the build gave a register of its own is read through that register:
the address of the field is the register and a displacement, where the general
form copies the object into the accumulator first. The copy is on every field
of every object the program walks, and the tree a checksum walks is nothing
but fields.

### A constant in both halves of a pair is read in one instruction

The instruction that puts a number in both halves of a vector register is a
second one — the load and the interleave — and a loop that multiplies by the
same number on every turn pays for it on every turn. The number is laid down
in both halves of a pair in the read-only data instead, and read from there in
one instruction. The pair the loop counts on is moved on by a number that is
the same on every turn, so it is read out of the data the same way.

The data section is aligned on sixteen bytes and the pair is given an offset
that is a multiple of sixteen, because the vector arithmetic of the legacy
instruction set reads its operand aligned and has no unaligned form.

### The register an object is filled in

The register an object literal is filled in is one the convention asks a
callee to leave alone, so a call does not take it. Only an allocation does,
and the slot the object was kept in is read only where a field's value
allocates: where none does, the slot was written and never read.

### A counter the body reaches only as an index is a whole number

The width of a counter reaches the arithmetic of the body wherever the body
reads it as a value, and an index is not a value: it is the place in an array
the body reaches, and the number of that place is a whole number whatever the
counter is counted in.

So a body that counts the elements of an array and indexes with the counter
is a body the counter's width does not reach, and the counter may be a whole
number however the arithmetic around it is written. The rule is in the
resolver (`ir-function.ts`), because it is a fact about the IR and not about
the machine: the loop is then counted in whole numbers by every backend, and
the machine backend keeps one counter instead of two and tests it with a
comparison of whole numbers.

### The bound of a loop in a register

The test of a loop of doubles needs the bound in a register: `UCOMISD`
compares its destination against its source, and the condition that answers
"less than" without the parity bit needs the *larger* side in the
destination. A bound in the frame is therefore read into the scratch first,
and the test is two instructions where one will do.

The register the bound is held in is one the convention asks a callee to
leave alone, so the calls the body makes do not take it, and it is taken
from what the expressions of the body have not taken: a bound is held for as
long as its loop runs, and the body borrows its registers one at a time. Two
loops nested one in the other need two of them.

### A loop that adds a progression counts the progression

`sum += i * 2 + 1` over a counter is a sum of an arithmetic progression, and
the progression can be counted: the counter the loop counts is the
progression itself, moved by the step of the progression, and the bound it
stops at is the bound the progression stops at. The turn is then the addition
of the counter to the accumulator and nothing else, where it was a
conversion, a multiplication and an addition.

The progression has to be a whole number of steps for the two to be the same
number, and the arithmetic of the turn has to be exact over the whole of the
range the counter takes — so the bound has to be a number the program wrote
out.

### The weight of a counted turn, and the step that moves it, are in registers

A turn that divides by a weight the counter decides — the triangular number a
spectral norm divides by — is a weight counted rather than computed: the turn
divides by the weight the turn before it divided by, moved by the step of the
progression. That is two running values, the weight and its step, and both are
read on every turn.

Kept in the frame, each of them is a store and a load per turn. Worse, the load
of the step is the first half of the addition that steps the weight, so the
chain the divisor waits on runs through the store-to-load forwarding of the
turn before: about nine cycles on a machine whose divider answers a turn in
four.

`reserveWeightedRegisters` asks `weightedPlan` — the same pass that rewrites the
loop — which loops the lowering will weight, and keeps a pair of vector
registers for each before any name is weighed. A pair either both live in
registers or the loop keeps the form it was written with; a weight in a
register and a step in the frame is the case that is slower than neither.

**`spectral_norm` went from 123 ms to 84 ms** on the machine below with this
change and the one after it, and the turn went from a store and two loads of
its own running values to none.

### A scalar in a register is moved as the whole register

`MOVSD` and `MOVSS` between two registers keep the half of the destination
above the value as they found it, so they wait for whatever last wrote the
destination as well as for what they read. In a loop the destination is usually
the accumulator, holding the quotient of the division the turn before wrote, so
the move waits for a division to answer — and the turn's next addition waits on
the move. The instruction is a chain of the divider's latency per turn.

`MOVAPD` and `MOVAPS` write the whole register and depend on the source alone,
which is the same fix as the `PXOR` before a conversion and for the same
reason. Nothing in this backend reads the half above a scalar: a value in a
register is written by the arithmetic that produced it and stored by a store
that names its width.

This is what made the registers above pay. On their own, moving the weight and
the step into registers was *slower* than leaving them in the frame — 166 ms
against 344 ms in the other direction — because every step of the weight
waited for the turn's division through the merge of the accumulator's half.

### A compound assignment carries a value that is already somewhere

`total += step` where `step` is in a register is the one addition whose source
is that register; it does not have to be copied into the accumulator first. The
same goes for a number the program wrote out, which the instruction carries
from the read-only data: `step += 1` is one addition and not a load of the
literal, a copy and an addition. The copy is a move, and the move is the wait
described above.

## What is left

### The strength reduction over a bound the program wrote

`sum += i * 2 + 1` over a counter is a sum of an arithmetic progression, and
the progression is counted where the loop's bound is a number the program wrote
out: the counter the loop counts is the progression itself, moved by the step
of the progression, and the bound it stops at is the bound the progression
stops at.

The arithmetic of the turn has to be exact over the whole of the range the
counter takes, because a double holds a whole number exactly only up to two to
the fifty-third, and the arithmetic the turn did in doubles held the number
exactly while the counter was under it. A bound the program wrote is a range
nothing knows when the program is compiled, so the loop is written as it was —
the multiplication and the offset are on every turn of it.

A bound written out of the range is a runtime question, and the two forms of
the loop are one branch apart: the bound is tested against the range, and the
loop is written in the form the answer calls for. That is a second copy of
every such loop, and a branch that is not there today.

### A bound that is not a number

A loop that counts in whole numbers compares its counter with the bound as a
whole number, and the bound is rounded to the whole number the comparison
against it answers the same. A bound that is not a number at all — one that is
not finite — has no whole number to be rounded to, and the conversion of it
answers a number no comparison against it would have given: a loop whose
bound is infinite stops at once rather than running for ever.

This is not new with the whole-number counting: a loop whose body is written
in whole numbers was counted that way before, and the bound was rounded the
same way. What the counting by index does is make more loops counted that
way, and so makes the case more likely to be met.

### A tail call

A function whose last statement is a call and whose answer is that call's
answer could hand the frame to the callee instead of setting one up for it,
and the call would be a jump rather than a call. A recursive program that ends
in a call is a third of the calls it makes, and the frame is a push and a pop
and a subtraction on each of them.

The convention is written in terms of a call and a return, and a jump to a
callee is neither: the callee would return to the caller's caller, which is
right for a tail call and wrong for every other, and the machine backend
would have to know which is which at every call it writes.

## The measurements

The programs are built with `node src/compiler/offline-build.ts <project>
<work>`, which is the rule-based half of a build with no model in it, and
timed with `hyperfine`. A change to the backend is measured by building both
before and after and running them alternately, because the machine this was
measured on is not quiet.

The `spectral_norm` timings above are wall time on the whole benchmark, which
`[benchmark]` in its `blaze.toml` runs as `./spectral_norm 1500`. The turn is
measured on its own by building once and repeating the run: 90 million turns
of the inner loop, which is what the ten passes of the two kernels make.

An instruction count is worth more than a stopwatch on a machine like this one.
`valgrind --tool=callgrind` answers how many instructions a program ran, and the
two forms of the weighted loop differ there by the two instructions a turn is
short — which says the change did what it was meant to before any clock is
asked. What the clocks then said is what the registers were worth:

| Form of the weighted turn | Inner loop | Single thread | Four threads |
|---|---|---|---|
| weight and step in the frame | 11 instructions | 344 ms | 123 ms |
| weight and step in registers, `MOVSD` moves | 11 instructions | 664 ms | 203 ms |
| weight and step in registers, `MOVAPD` moves | 11 instructions | 166 ms | 84 ms |
| the above, with the compound assignments carrying their value | 8 instructions | 164 ms | 83 ms |

The second row is the one worth keeping: the registers are only worth having
when the moves into and out of them do not wait on the division of the turn
before, and the form that puts them in registers *without* that is twice as slow
as leaving them in the frame.


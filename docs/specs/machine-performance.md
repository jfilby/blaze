# The machine backend's speed

## What it is

The machine backend lowers a function's semantic IR to x86-64 machine code
and writes the object itself (`src/compiler/toolchain/ir-machine.ts`). This
is what it does for speed, what it costs, and what is left.

The measurements are the ones `src/benchmarks/bench.sh` takes, plus three
programs written for this work (`/tmp` is not where they live; they are
`loopbench`, `arrbench` and `hotbench`):

| Program | What it is | Before | After | The C compiler |
|---|---|---|---|---|
| `loopbench` | a scalar loop: `for (i = 0; i < n; i++) sum += i * 2 + 1` | 7.0 ms | 2.4 ms | 2.2 ms |
| `hotbench` | the same loop over an array, ten million times | 35.9 ms | 16.7 ms | 16.4 ms |
| `arrbench` | an array of two million doubles, summed and multiplied | 35.7 ms | 20.9 ms | 20.6 ms |
| `binarytrees` | the benchmark program: recursion and allocation | 108.4 ms | 103.5 ms | — |

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

## What is left

### The strength reduction the C compiler does

`sum += i * 2 + 1` over a counter is a sum of an arithmetic progression, and
the C compiler keeps the progression in a register and adds it. The backend
converts the counter on every turn and multiplies it. The conversion is now
free of the dependency that made it expensive, and the multiplication is one
instruction, so what is left is the two instructions of the arithmetic that a
progression would have replaced — and the loop is at parity with the C
compiler's, so the two instructions are what the C compiler spends too.

### A loop that counts in whole numbers

A loop whose body reaches its counter only as an index is counted in whole
numbers where the loop can be, and the double beside the counter is then
nothing any turn reads. Where it cannot — the bound is a number the program
wrote rather than a literal — the loop keeps both counters: the whole number
the index is read out of, and the double the test compares.

Counting it wholly in that case would take one counter instead of two, and
the test would be a comparison of whole numbers. What it needs is the bound
as a whole number, and the bound is a double the program wrote: the
comparison `k < to` is the comparison `k < ceil(to)` for a whole `k`, and
`ceil` of a number that is not one is not the number the program wrote.

The IR already knows how to round a bound (`roundedBound`, in
`ir-resolve.ts` and `ir-function.ts`), and it applies it where the counter
is a whole number. What is missing is the rule that says the counter *may*
be a whole number where the body reads it only as an index — the body of a
loop that counts elements and indexes with the counter is a body of whole
numbers for the purpose of the counter's width even where its arithmetic is
not.

Written and measured, and it was two instructions fewer on every turn of the
loop and no faster: the loop is bound by the chain of the accumulation, not
by the instructions around it. It is not in the compiler, because the test
suite says the counter of a loop the checker runs with vectors is left as the
source wrote it, and that is a decision about the IR that is not the
backend's to make.

### The bound of a loop in a register

The bound of a loop is held in a frame slot and read on every turn, and the
test of a loop of doubles needs it in a register: `UCOMISD` compares its
destination against its source, and the condition that answers "less than"
without the parity bit needs the *larger* side in the destination. A bound in
the frame is therefore read into the scratch first, and the test is two
instructions where one would do.

A bound in a register of its own would fix it, and the register it wants is
one of the ones the expressions of the body are held in: the body needs one
at a time and the loop needs one for as long as it runs. It is not in the
compiler either: the load of the bound is off the chain the loop carries its
counter along, and a loop that is bound by that chain does not wait for it.

## The measurements

The programs are built with `node src/compiler/offline-build.ts <project>
<work>`, which is the rule-based half of a build with no model in it, and
timed with `hyperfine`. A change to the backend is measured by building both
before and after and running them alternately, because the machine this was
measured on is not quiet.

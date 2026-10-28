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

### A wide kernel is handed the value it is given

A wide number is four limbs, and the kernel that multiplies two of them is C in
the runtime that takes the address of each. The lowering used to evaluate every
argument into the working registers and then write it to a slot of the frame,
which is four loads and four stores per argument that say nothing at all when
the argument is a name that already lives in a slot: `dx` is four limbs in the
frame, and `lea 0x40(%rsp), %rsi` is the address the kernel wants.

The address of a name is therefore handed over as it is, and the only arguments
that are copied are the ones the value computes. The answer is the same
question: a modular operation bound by the statement that makes it —
`let X3 = (r * r) mod P` — is written straight into the binding's slot rather
than into a temporary and then copied to it, which is another eight instructions
per operation. Two of the three kernels read each limb before writing the limb
over it, so the answer may be written over an operand; the third is division,
whose kernel clears the quotient before it reads the dividend, and its answer is
still staged. A value that reads the name it is bound to is copied as well,
because whether the aliasing is the same program then depends on the kernel's
own order rather than on the lowering's.

### A wide number crosses a call the way the convention says

A wide number is four limbs, and a function that answers one hands it back
through a pointer its caller sets aside: the pointer arrives in `rdi` ahead of
every argument, and the answer is four stores through it before the return. A
caller that makes such a call writes the address of a slot it owns into `rdi`,
and the arguments of that same width travel on the stack — four slots each,
sixteen byte aligned — because no register file has room for thirty-two bytes
beside five other arguments. An argument of a narrower width still takes the
register it always took, and the wide argument before it takes none.

The address a wide answer goes to is the slot the call was going to be copied
into anyway when the call is what binds a name, so a lowered curve formula pays
the call and not a copy after it. The one case the direct write is not taken is
the call that reads the name it is bound to, which is the one case the kernel
answers have the same rule for and for the same reason.

A wide field of an object is written where the field is, from the limb
registers, and read the same way: an object is a pointer, so the four limbs are
four stores off it rather than a value the accumulator carries. The address of
the object being filled is kept in a slot across a field's value, because a
field whose value is a kernel call is written by a call that takes every
register the caller holds nothing of.

The text of a wide number is the runtime's formatter asked for base sixteen,
which is what `x.toString(16)` is. A narrow whole number is widened into the
same four limbs and asked for the same base; a fraction has no hexadecimal form
here, and the C backend refuses the count of digits rather than writing the
number without them.

### A modular multiply by a small number is the addition it is

`2 * x` modulo a prime is `x + x` modulo the same prime, and a modular addition
is the cheap kernel beside the multiply: the multiply is sixteen 64 by 64 limb
products and a reduction, and the addition is four adds and a conditional
subtract. The optimizer writes a modular multiply by two or three as the
additions it is, which is the rewrite that matters for a curve's formulas: a
point doubling written in Jacobian coordinates multiplies by 2 and by 3, and two
of the eleven multiplies in the doubling of `secp256k1`'s source are of that
kind.

Three is `(x + x) + x` and two is `x + x`. A count above three is left as the
multiply it is, and the reason is not the arithmetic but the binding: eight is
three doublings only if the first doubling is written once and read three times,
and a value that is not bound is computed at every read, so a chain of three
additions is a tree of seven. The count is read from the side the compiler can
see, which is a literal or a `u256_from_u64x2`/`u256_from_u64x4` of literal
limbs.

The other side is read for the same reason. The answer is that side written
once or twice, so doubling a value that itself computes something is two copies
of every operation in it. `2 * ((x + y) - z)` is therefore left as the multiply
it is; only a name, a literal, or a wide constant built from its limbs is free
to write twice. A curve's doubling multiplies a name by two, and the one
compound operand it has — the square of `x + y` — is left alone.

### A modulus the compiler read is the arithmetic of that prime

The modular kernels take the modulus as an argument, so the general entry works
out on every call whether it was handed a special prime: it sets the top bit,
negates the four limbs to get `c`, and checks that the complement fits in one
word. That is the right thing for a modulus nothing knows, and the wrong thing
for one the source wrote out — and the optimizer hands the backend the modulus
as a constant, so the decision can be the compiler's instead.

When the third argument of `u256_mul_mod` is a wide constant `2^256 - c` with
`c` below `2^64`, the machine backend:

- calls `blaze_rt_u256_mul_mod_special` with `c` as an immediate, which is the
  same reduction without the test and without rebuilding `c` from the modulus;
- writes `u256_add_mod` as the four limb addition it is, plus the two things
  the shape says: a carry is `2^256`, which is `c` modulo this modulus, and a
  sum that did not carry is below twice the modulus, so one subtraction settles
  it;
- writes `u256_sub_mod` as the four limb difference it is, plus `c` where the
  difference borrowed. A difference of two residues that did not borrow is
  already below the modulus, so it needs no subtraction at all.

The arithmetic is still the runtime's when the modulus is a name, or when the
complement does not fit in a word. The C backend keeps the general entry for
both shapes, because it has no rule that folds a modulus into the call.

The reduction itself is inlined into the special entry (`always_inline`), which
is worth the 5% it costs the general entry: `mul_mod_special` was a call of 123
instructions beside the 183 the product takes, and folding it in leaves the
compiler free to keep the limbs of one pass in registers across the next.

### An object literal that writes every field is not cleared

An object literal writes its whole payload before any of it is read, so a block
cleared first is a pass over the object the program never asked for. A literal
that writes every field of its layout is therefore given the runtime's
`allocate_uninitialized`, and one that leaves a field out keeps the cleared
block — a program is allowed to read a field it never wrote, and the source
answers that read as a zero.

The C backend had made this choice since it was written (`writesEveryField` in
`toolchain/ir-c.ts`); the machine backend had not, and the clearing was 12% of
`binarytrees` — a quarter of it inside `memset`, and the rest of it the cache
line per node that a second pass over the payload touches.

### An uncleared block of a region is its header and its payload

A cleared block keeps a whole alignment of room past the end of its payload.
Those bytes are what a read past the end of the block answers with, and the
source language answers that read as a zero, so the room is what makes the
answer true and it stays.

A block that is *not* cleared has no such answer to give: its caller writes
every byte of its payload before reading any. So the only room it needs past the
header is what places the payload on the alignment it asked for — and the header
is three sixteens long, so a payload placed at the header's end is already
placed on every alignment up to sixteen as long as the region's cursor is
16-byte aligned. Rounding the span up to sixteen is what keeps it so.

This is the working set of a program whose marked loop builds a value per turn.
A node of sixteen bytes advanced the cursor by eighty bytes before and by
sixty-four after, so a loop that builds a tree of such nodes touches a fifth
less memory — and on `binarytrees` that fifth was worth more than every
instruction the allocator executes.

## What is left

### The header of a block a region hands out

Two fifths of what is left of `binarytrees` is the region's own layout: a node
of sixteen bytes is given a header of forty-eight before it, so sixty-four bytes
of the cursor's travel buy sixteen bytes of tree. Measured by cutting the header
away — which is not a program any of this may ship, and was done only to price
the change — the program ran 1.3 times faster than it does now, with the slack
already gone.

What a sound version needs is a proof about a layout rather than about one
allocation: that no block of it anywhere in the program is ever released,
retained, resized, measured, or handed to a runtime call that reads a header,
and that the block does not outlive the region it was taken from. A block that
answers yes to that can be the payload and nothing else, and the region's cursor
advances by the payload rounded to sixteen.

The proof is a whole-program one because a block escapes the function that
allocated it: `createTree` hands its tree back and `checksum` walks it, and
neither of them is where the answer is. It is also a proof about the *runtime
calls the program makes*, because `ref<any>` is a value any of them may be
handed. A first version could refuse any layout a dynamic (or otherwise opaque)
call in the program can be given.

### The instructions a recursive call spends on one value

`createTree` is twenty-four instructions a node, and three of them are the same
number moved three times. The source is `depth-- > 0 ? … : …`, whose IR is a
`let t1 = depth`, a step of `depth`, and a test of `t1`; the parameter, the
`let` and the read of it for the test are three copies of one value in three
registers because each is a name the build gave a register of its own and the
accumulator is how a value moves between them.

Two of those are the accumulator discipline rather than the `let`: a value read
out of a register-held name is copied into the accumulator, and a value stored
into one is copied out of it. The pair is a move when the source and the
destination are registers, and the `let` could be one move rather than three if
the store knew the accumulator had just been loaded from the same slot — the
lowering keeps a note of that for the frame but not for a register.

### A field read twice

`checksum` tests `node.left` for nothing and then passes `node.left` to the
recursive call, and the two are two loads of the same field with nothing that
could have written it in between. The C compiler eliminates one of them; the
machine backend has no such pass, and a load is a seventh of what the function
spends on a node.

### A comparison whose other side is a literal

`t1 > 0` is lowered as a load of `0.0` into the scratch and a comparison against
it, because the operand order a float comparison needs puts the *larger* side in
the destination and the literal is the larger side only for `>` and `>=`. For
those two the literal can be the instruction's own memory operand
(`sseCompareLabel` already exists for a literal in the read-only data), which is
one instruction less on the test of every loop written `while (i > 0)`.

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

### The multiply the machine code calls

The modular multiply of `secp256k1` is now 56% of the program's instructions,
and it is still a call into the runtime: the machine backend asks the kernel
for the product and the reduction, and a call is what it writes. The kernel is
about 275 instructions for sixteen limb products and a reduction, and the call
boundary is not where most of them are.

What the call costs beyond the arithmetic is the boundary. A kernel written
into the machine code at the call site lets the compiler keep its operands in
registers across the product and pipeline one multiply into the next. The
special-prime kernel inlined into a loop that calls it was 1.58 times faster
than the same kernel called; that measurement was taken against the general
entry, and the special entry this round added has already taken the modulus
test and the rebuild of `c` out of the boundary. What is left to win by writing
the 4 by 4 product as x86-64 here is the register traffic around it, not the
arithmetic, and the reduction of `2^256 - c` is the shape that makes it worth
doing: a generic modulus would need the bit-by-bit reduction, which is not
worth writing at twenty call sites.

The shape the kernel does have now is the one the previous round priced: the
special-prime reduction taken unconditionally, chosen by a compiler that folded
the modulus into the call. That was the 12% that looked small, and it is 12% of
every product in a program that no longer has to prove which kind of modulus it
holds on each one.

### The division the inversion turns on

The extended Euclidean inversion at the end of `secp256k1` used to be the
second largest thing in the program. Its divisions alone were 1.33M
instructions of the program's 4.22M, because the division was the restoring
kind — one bit of the dividend per iteration, a shift of all four limbs, a
comparison and a conditional subtract. That is the right algorithm for a
division whose operands are unknown and the wrong one for the Euclid loop's,
where both sides are wide and the quotient is small.

The kernel is now Knuth's algorithm D: a limb of the quotient per turn, an
estimate from the top two limbs of the divisor, and at most two correcting
subtractions. The 256 by 256 sweep in `test/u256-kernel.test.ts` holds it to
`BigInt` limb by limb over boundaries, full-width random pairs, small divisors
and hand-traced cases. A division of a full-width pair fell from about 5,170
instructions to about 300, the inversion's share of the program fell from 31%
to 4%, and the inversion stopped being the second largest thing in the program.

### A scalar multiplication, a window at a time

What is left after the modular arithmetic is not the cost of a product but how
many of them the scalar multiplication asks for, and the multiplication walks
the scalar one bit at a time: 256 doublings and, for a scalar of random bits,
128 additions. An addition of Jacobian points is sixteen limb products where a
doubling is nine, so the additions are nearly half of the products the whole
multiplication runs.

`semantics/optimize-ir.ts` now rewrites that loop as a window of four bits. The
multiples `2P` through `15P` are built once, from each other, and every turn of
the loop then doubles the accumulator four times and adds the one multiple the
next nibble names. The doublings stay at 256; the additions fall from 128 to
the 64 nibbles, and one of those adds nothing when the nibble is zero.

The table is why the window pays: seven doublings and seven additions build the
fourteen multiples, and the additions the window removes are 64 points, which
is 64 times sixteen limb products against 175 products for the table. The
multiplication fell from 1.93M instructions to 1.62M and `./program 15` from
about 9 ms to about 7.5 ms, which is the 16% the arithmetic predicts.

The pass recognizes the shape rather than a name: a `while` whose test is a
`u256` name against zero, whose body adds a point to the accumulator when the
name's low bit is set, doubles the point and shifts the name down, and whose
accumulator starts at the identity — the point with `x` and `z` zero. A loop
whose accumulator starts anywhere else is left exactly as it was written,
because a window starts from the same accumulator and doubles it on every
turn: anything but the identity would be multiplied by two to the width of the
scalar on the way. It also needs the point operations the loop calls to be the
group operations they are named for; the shape and the identity are what the
compiler can prove, and a pair of methods that are not those operations is not
a pair the compiler can tell apart.

### The endomorphism the source still describes

The other change the source describes is the one still not compiled: the
endomorphism would split the scalar into two halves and halve the doublings,
which is the largest remaining factor. It is blocked by more than the
destructuring in its branch. The split computes `divNearest(b2 * k, n)` where
`b2` is about 2^128 and `k` is the scalar, so the product is up to 384 bits and
the quotient is about 128 — a shape the wide arithmetic of the IR does not
have. Every wide value is 256 bits, and the kernels answer a product modulo a
modulus rather than the high half of the product a division needs. Enabling the
branch therefore needs a wide product-and-quotient operation in the IR and in
the runtime first; the frontend's destructuring is the smaller half.

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

### What the allocator was worth on `binarytrees`

The same method, on the benchmark program: `hyperfine --warmup 5 --runs 40
'taskset -c 0 ./program 17'`, with the forms built from this tree and run one
after another. The program's instruction count is the deterministic half of the
pair — `valgrind --tool=callgrind ./program 14`, which is a smaller depth so
that a run is a minute and not five — and the clock is the half the machine
gets a vote in.

| Form of the allocation | Instructions at depth 14 | The program at depth 17 |
|---|---|---|
| the tree before this round | 287.0M | 527 ms |
| an object literal that writes every field is not cleared | 232.5M | 507 ms |
| and an uncleared block of a region is its header and its payload | 235.5M | 454 ms |

The first change is 19% of the instructions and 4% of the clock: what it removes
is a pass over the payload that the processor pays for in bandwidth rather than
in instructions, and the payload of a node is two words. The second is thirteen
more instructions a node — the header's stores are the same and the room test is
a word narrower — and 12% of the clock, because what it removes is a fifth of
the memory the turn touches. Together they are 1.2 times the program, and the
run-to-run spread on the machine this was measured on is ±6%, which is why each
row is a change of one thing.

The allocator's *instructions* are not what those milliseconds were. A fast half
of the region's allocation made into a leaf function — no frame, no spill, the
room test first — took the allocator from 28.7 instructions a block to 27 and
was worth 4% at most, while the span of the block was worth 12%. That change was
withdrawn rather than kept: the C compiler emits different code around it even
where the C is the same, and a shared-block program in the suite (a spectral
norm over three windows of one `SharedArrayBuffer`) printed a different answer
with it. Four percent is not worth an unexplained difference in what a program
computes, and the same four percent is the reason the *next* change to that
function is worth measuring rather than reasoning about.


### What the two changes were worth on `secp256k1`

The benchmark multiplies the curve's generator by the private key the program
states, as many times as its argument says: `./secp256k1 15` is fifteen of them.
It is built with `node src/compiler/cli.ts build --recompile`;
`offline-build.ts` builds it too now, and the paragraph at the end of this
section says why it did not before.

The first change the benchmark needed was not arithmetic at all. The program's
comments cite two URLs, and the compiler decided from the text of the file
whether a program serves HTTP and whether it speaks TLS: `\bhttp\b` matched
`http://hyperelliptic.org` in a comment, and `https://` matched the citation
above it. The program was therefore linked against the facil.io server, the
table of connections it sizes at startup, and OpenSSL, none of which it calls.
The readers in `util/source.ts` take the comments out before the question is
asked, and leave the literals because a URL in a string is a request the
program makes and a URL in a comment is prose about one.

| Form of `./secp256k1 15` | The binary | One run |
|---|---|---|
| before this round | 220,864 bytes, with libssl and libcrypto | 4.4 ms |
| the runtime read from the code | 31,400 bytes, libm and libc only | 1.3 ms |
| the count the benchmark states | 39,608 bytes, the same two libraries | 9.3 ms |

The last row is the benchmark as its `[benchmark]` line writes it: fifteen
scalar multiplications, where the row before it was the same binary ignoring the
`15` and computing one. One run is 1.3 ms with the argument set to `1` and 9.3 ms
with it set to `15`, so a multiplication is about 0.57 ms after the runtime is
up, and the fifteen are the work the benchmark claims to do.

The program's own work was measured on its own — the machine object linked into
a harness that calls `blaze_main` two hundred times, so the runtime's startup is
one run and not two hundred:

| Form of one scalar multiplication | Instructions (callgrind) | Two hundred turns |
|---|---|---|
| before this round | 3.46M | 105 ms |
| the additions and the slots | 3.01M | 86 ms |

The instruction count is worth reading by function, because it says where the
saving came from and where it did not. The modular multiply fell from 2.03M to
1.64M and the modular addition rose from 28k to 183k, which is the rewrite: the
multiplies by 2 and by 3 became the cheap kernel, and the remaining multiplies
are the ones that were not by a number the compiler could see. The program's own
code — the calls, the operand copies and the branches between them — fell from
375k to 157k, which is the slots: 218k instructions of the 3.46M were the twelve
loads and twelve stores a kernel call spent on arguments the frame already held
and on an answer it was about to copy. The extended Euclidean inversion at the
end of the program is untouched at 663k, a fifth of what is left: it is a
division per turn of the algorithm, and the division is the bit-by-bit kernel.

### What the modulus and the division were worth on `secp256k1`

The measurements below are of the tree this round started from and are the same
method: `node src/compiler/offline-build.ts <project> <work>`, then
`valgrind --tool=callgrind ./program 1`, which is one scalar multiplication of
fifteen in the benchmark. The tree's own count is larger than the 3.01M of the
section above because the tree is not the same one; the ratios are the change
this round made and the rest is not read across the two.

| Form of one scalar multiplication | Instructions (callgrind) | Against the start |
|---|---|---|
| the tree this round started from | 4.22M | — |
| the division by 64 bit limbs | 2.98M | 1.42 times fewer |
| the modulus read, and the additions and subtractions written out | 2.02M | 2.09 times fewer |
| the reduction folded into the special entry | 1.93M | 2.19 times fewer |
| the scalar walked four bits at a time | 1.62M | 2.61 times fewer |

By function, the modular multiply fell from 1.68M to 913k — the special entry,
the inlined reduction and the additions the window removed — the modular
addition fell from 268k to none and the modular subtraction from 376k to 42k,
which are the limb chains they became, and the division fell from 1.33M to 85k.
The count is worth more than the clock here: `./program 15` went from about
22 ms to about 7.5 ms on the machine this was recorded on, which is nearly 3
times, and that machine's run-to-run spread is wide enough that the instruction
count is the half that is worth quoting.

### The fidelity of `./secp256k1 15`

The rules that translate this program used to fix its scalar to a literal and
read no argument, so the binary performed one multiplication and ignored the
`15` its `[benchmark]` line names. What the rules do now is what the source
says: `main` keeps its `const n = +Deno.args[0] || 1`, its counted loop and its
`Point_multiply` call, and the loop runs the multiplication as many times as the
argument asks. `./secp256k1 15` answers the point fifteen multiplications of the
private key reach, and `./secp256k1 1` answers the one it reaches first; both
agree with the source run by the host, which is what the compiler checks a
program against.

Getting there needed four things the backend and the frontend did not have, and
each is a general one rather than a rewrite of this program:

- `Deno.args[i]` is read by a function body, contract reader included, as the
  `process.argv[i + 2]` it is. The reader refused the index on a member access,
  so the translation replaced the form with a builtin that the host running the
  source does not define.
- A short circuit bound to a name holds the type of the arms it hands back, not
  a truth: `const n = +Deno.args[0] || 1` bound a truth, and every loop over the
  count was refused as a comparison of a number with a truth.
- `x.toString(16)` is a number written in base sixteen, and the IR text form now
  writes that count as `to_text@hex` and reads it back the same way. The machine
  backend asks the runtime's wide formatter for the base; the C backend refuses
  a count of digits rather than writing the number without them.
- A wide number crosses a call the way the convention says, which is what lets
  the multiplication and the inversion be functions rather than one inlined body:
  a wide answer through a pointer, wide arguments on the stack, wide fields
  written and read in place.

The arithmetic lowering is partly the compiler's own and partly a source-level
one. The compiler folds a constant `bigint` expression at the width the answer
is held at, writes a power of a whole number as the products it is, tests a wide
condition against zero, and lowers a `u256` remainder over a sum, difference or
product to the kernels that reduce without an intermediate the width cannot
hold. What is still a source-level lowering is the call of `mod` itself: its
parameter is a `bigint` at the width a bigint is, and the product the call hands
it is wider than that, so the call has to be opened where the source wrote it
before the compiler can see the remainder. What changed is where the lowering is
written: the reductions of `mod` are the kernels in every expression of the
program, the inversion's steps are taken modulo the order, and the
multiplication's formulas are the source's own, so the loop and the count main
reaches the multiplication with are the source's too. The one transcription
error the lowering had is worth recording because it survived in the source for
a while: the doubling of a point wrote `E * (D - x)` where the formula says
`E * (D - X3)`, which negates the coordinate of the doubled point, and the
point that follows is the negation of the answer.

`offline-build.ts` builds this project now as well. It refused the entry before
because the class-to-object rewrite typed the zero point's fields from the small
literals and the base point's from wide ones, so two layouts of one name
disagreed; the statics are gone from the lowered program, and the layout nothing
reads does not have to agree with anything.


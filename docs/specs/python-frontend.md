# A Python frontend for Blaze

## What it is

Blaze reads TypeScript and Nim. A frontend is a parser and an analysis and
nothing more: it reads a source file into a module analysis
(`semantics/module.ts`), contracts the functions the file declares
(`semantics/contract-build.ts`), and — for the entry module of a program —
reads the statements the file runs as a program body. Everything past the
frontend is language neutral: one IR (`core/ir.ts`), one semantic IR
(`core/semantic-ir.ts`), one contract language, one set of backends. A Nim
proc and a TypeScript function are the same thing to everything past the
frontend, and a Python function has to be the same thing too.

This document is what it would take: the subset of Python the frontend reads,
the mapping of Python's types and operators onto the compiler's, the places
where Python's semantics and the compiler's differ, what the compiler has to
change to settle each of them, and what is left out.

The scope is the first version: a Python **module** (a library of functions) and
a Python **program** (the statements of the entry module), the compiler's value
model (a number, text, an array, an object, a reference), and the arithmetic
and the text of a value that Python spells its own way. Not in scope: classes,
generators, coroutines, decorators, comprehensions, context managers, pattern
matching, `async`, and the standard library. A Python program is a program of
this compiler that was written in Python, not a Python runtime: the source is
compiled, and what runs is a native binary.

The rule everything rests on is the one the compiler already keeps: **the
source is the specification**. A build runs the Python source on `python3` and
runs the delivered binary, and compares what the two print
(`toolchain/verify-program.ts`). So every place where Python and the compiler
would answer differently is either settled deliberately or refused by the
frontend. A Python program that prints what its source prints is a program the
compiler got right; one that does not is a program the compiler says is wrong,
and it is wrong.

## The parts

| Part | Where | What it is |
|---|---|---|
| The tokenizer and the parser | `semantics/python.ts` | the tokens of a Python file and the tree they make |
| The module subset | `semantics/python.ts` | what a file declares: its functions, its imports, its types |
| The program subset | `semantics/python-program.ts` | the statements of the entry module, as the program body |
| The rules of a language | `semantics/language.ts` | the arithmetic and the truth of a value, per source language |
| The registration | `semantics/frontend.ts` | `frontendFor("python")` |
| The oracle | `toolchain/verify-program.ts` | `python3` as the toolchain a Python source is checked against |
| The text of a value | `runtime/abi.ts` | the style a number, a boolean and a null are written in |

The two frontends that exist are shaped the same way, and the Python one is
shaped after them: `semantics/typescript.ts` reads a module and
`semantics/typescript-program.ts` reads the statements of a program, and
`semantics/frontend.ts` picks between them by the language the project names.

## The shape of a program

A module is a library of functions, and the entry module of a program may also
carry the statements the program runs. Python writes both the same way, so the
split is the same one the contract phase already makes: a file is a program
when it has a top level statement that is not a definition, and a library
otherwise.

A module, `helpers.py`:

```python
def dot(a: list[float], b: list[float], n: int) -> float:
    total: float = 0.0
    for i in range(n):
        total += a[i] * b[i]
    return total
```

A program, `main.py`:

```python
from helpers import dot

def main() -> int:
    a = [1.0, 2.0, 3.0]
    b = [4.0, 5.0, 6.0]
    print(dot(a, b, 3))
    return 0

if __name__ == "__main__":
    main()
```

Both are read into the shapes the compiler already has: `dot` is a declared
function with typed parameters and a declared return, and `main` is a
function of the program body, and the statements around it are the program.

The length of a list is a parameter of its own, and not `len(a)`: a list
reaches a function as a pointer to its first element and no length arrives
with it, so a function that asks the list for its length is refused (see
"What is refused, and what it says" below).

## The subset

### The module subset

A module is a file of functions. The frontend reads:

- `def name(a: int, b: float) -> float:` — a function, with its parameters
  typed by annotation and its result typed by annotation;
- `from helpers import dot` — an import that binds the named functions of
  another file of the project;
- `import math`, `import sys` — the two modules of the standard library the
  compiler knows: `math` is where the roundings and the root the compiler has
  are written, and `sys` is where the command line is. Every other import is
  refused, because a module of the standard library is a file the compiler
  does not read;
- and, in the body of a function: a binding (`x = expr`), a compound
  assignment (`x += expr` and the other compound forms), a counted `for` over
  `range(...)`, a `while`, an `if` / `elif` / `else`, a `return`, a `break`, a
  `continue`, a `pass`, a `print`, and an expression statement that is a call.

A module function may call a function the project declares and the builtins
below. It may not call anything else: a call of a name the compiler does not
know is refused, as it is for a TypeScript module
(`semantics/typescript.ts:1389`). A function that prints states no
postcondition, because a contract states what a function returns and a
function that prints returns nothing to say.

The builtins a module function may call are the ones Python has as builtins
and the compiler has as operations:

| Python | What it is |
|---|---|
| `len(x)` | the length of a list or of a text |
| `range(n)`, `range(from, to)`, `range(from, to, step)` | the bounds of a counted loop, and nothing else |
| `abs(x)` | the magnitude of a number |
| `min(a, b)`, `max(a, b)` | the smaller or the larger of two numbers |

`round` is **not** in the subset: Python rounds half to even and the compiler
rounds half up, so `round(2.5)` is 2 in Python and 3 here. The other
operations the compiler has — `floor`, `ceil`, `sqrt`, `trunc` — are not
builtins of Python either, and a program that wants one writes it as
`math.floor(x)`, which is a name the compiler knows and not a file of the
project (see the program subset below).

A loop that accumulates into a name is stated as a reduction, as it is for a
TypeScript module: the body of `dot` above is a reduction over `range(n)`,
and its contract says `result == sum(i = 0..<n, (a[i] * b[i]))`.

### The program subset

The entry module of a program may also carry statements. The frontend reads
the module subset's statements and, in addition:

- `print(a, b)` — what the program writes;
- `int(x)`, `float(x)`, `str(x)` — a conversion. `int(x)` answers a whole
  number, as it does in Python;
- `math.floor`, `math.ceil`, `math.sqrt`, `math.trunc` — the compiler's other
  operations, under the names Python spells them in its `math` module. `math`
  is a name the compiler knows: it is not a file of the project, and the file
  that uses it writes `import math` as Python does. `math.floor(x)` and
  `math.ceil(x)` answer a whole number, as they do in Python, and
  `math.sqrt(x)` answers a fraction;
- `if ... elif ... else`, `while`, `for ... in range(...)`, `try` / `except` /
  `finally`, `def`, `return`, `break`, `continue`, `pass`;
- a conditional expression (`a if c else b`), which Python writes with the
  value first and the condition after it;
- a list literal (`[1.0, 2.0]`), a dict literal (`{"a": 1}`), an f-string
  (`f"{x} items"`), and the indexing and the field access of both.

A string written as a statement of its own says nothing: it is the docstring
of a function or of a module, and Python reads it and throws its value away. A
string of three quotes is a string of three quotes, and it may hold the line
breaks a string of one may not.

A dict is an object, and its fields are read by their key: `d["key"]` is a
field of the object the name holds, and not an element of a buffer of
numbers. A dict has no fields of its own in Python — `d.key` is an attribute
the language does not have — so a field read of one is refused.

The length of a value written out is not read: `len("hello")` is the length of
a text, and the compiler reads a length off the name it is written by, so a
program writes `s = "hello"` and then `len(s)`.

**A compiled program cannot raise, so nothing catches.** The block of a
`try` that catches is read past, and the block of a `finally` runs: the body
runs as it is written, and what Python would have raised is not raised at all.
A program that divides by zero prints `inf` where Python prints nothing and
raises, and the build says so — the source is the specification, and the two
disagree. This is the rule the TypeScript frontend keeps as well, and the
reason is the same one: there is no exception to raise in a compiled program.

### What is refused, and what it says

Every construct outside the subset is refused with the line it was written on
and what to write instead, and the rest of the file is still read, so one
program says everything that is wrong with it at once. The refusals that
matter are the ones a Python program is most likely to write:

| Refused | Why, and what to write instead |
|---|---|
| `class` | an object written where it is made, as in `{"left": None, "right": None}` |
| `yield`, `async`, `await` | a straight line: a compiled program has nothing to wait for |
| a comprehension | a loop that fills a list, written out |
| a decorator | a function is called where it is written, and the decorator is not run |
| `in`, `not in` | a loop that looks for the value |
| `for x in a:` | a loop walks a range: `for i in range(len(a))` |
| `*args`, `**kwargs` | a fixed list of parameters |
| `str.format`, `%` on a text | an f-string |
| `round` | it rounds half to even, and the compiler rounds half up |
| a match | a chain of `if` / `elif` |
| `print(..., sep=`, `end=` | a plain `print` |
| an import of a module but `math` and `sys` | a module of the standard library is a file the compiler does not read |
| a call of a name the compiler does not know | a file calls the functions it declares, the functions it imports, and the builtins of the subset |
| `sys.argv` in a function of a module | a module is a library of functions, and a library reads no command line: the command line is read by the program |
| `d.key` where `d` is a dict | a dict is read by its key, as in `d["key"]` |
| `len("hello")` | the length of a value written out is not read: write it into a name and take the length of that |
| a set, `{1, 2}` | a dict is written with named keys, as in `{"a": 1}` |
| `a.append(x)` | a list is a buffer, and a buffer is fixed: the list a program uses is the one it wrote out |

## The types

A Python type is written down, because the compiler's are: a function's
parameters and its result are typed in the contract, and the contract has no
way to say "whatever it is" for anything but a reference.

| Python | The contract's type | What it is |
|---|---|---|
| `int` | `i64` | a whole number of sixty-four bits |
| `float` | `f64` | a number of double width |
| `bool` | `bool` | true or false |
| `str` | `text` | a text the runtime holds |
| `list[float]` | `slice<f64>` | a buffer of numbers, read only |
| `list[int]` | `slice<i64>` | a buffer of whole numbers, read only |
| `None` | `void` | nothing |

The rules:

- **An annotation is required** on every parameter and on the result of every
  function, in both subsets. Python does not ask for one and the compiler
  cannot do without it: a parameter with no type is a reference to nothing,
  and the contract of a function with a reference parameter says nothing about
  what the function does with it. The message names the parameter to write.
- **A local may be annotated**, as `total: float = 0.0` is, and the
  annotation names the type of the name. A local with no annotation is a name
  whose type the resolver settles from what it is given, as it is for a
  TypeScript program.
- **A list parameter is read only.** The contract's memory section states the
  ranges a function reads and the ranges it writes, and a Python list is a
  reference the caller owns; a function that writes into it says so in the
  contract, and the contract language of this compiler states no writes. So
  `list[float]` is a buffer the callee reads, and a function that changes it is
  refused.
- **`-> None` is a function that returns nothing.** A function with no return
  statement is the same.
- A parameter of any other type is refused with the types the subset has.

## The semantics that differ

This is the part of the work. Python and the compiler disagree about a
number of things, and every one of them has to be settled here rather than
found later by a program that prints the wrong thing.

### A whole number is sixty-four bits

Python's `int` is of unbounded width, and the compiler's whole number is
sixty-four bits. So:

- A whole number literal outside the range of a signed sixty-four bit number
  is refused, with the number it is and the range it has to be in.
- Arithmetic on whole numbers is arithmetic on sixty-four bit numbers. A
  program whose whole numbers leave that range is a program that overflows,
  and the compiler does not check it: the contract's numeric section says the
  arithmetic is IEEE 754 for a float, and a whole number that overflows is
  the two's complement answer, which is what the machine gives.
- Python does not overflow, so a program that overflows prints something
  different from its source. The build catches it when the value is printed
  and not otherwise, and the spec says so rather than pretending otherwise.

The program's model already has a whole number kind — the one TypeScript
writes `1n` — and it is the `i64` a whole number is. The name is a
TypeScript spelling and it means the opposite of what it means in Python, so
the kind is renamed `whole` when this frontend lands: the rename touches
`semantics/module.ts`, `semantics/typescript-program.ts`,
`semantics/program-objects.ts` and `semantics/ir-resolve.ts`, and nothing
else.

### The division is a true division, and the floor is a floor

Python's `/` is a true division: `7 / 2` is `3.5`, and it is `3.5` whatever
the two sides are. The compiler's division of two whole numbers is a whole
division, which is what TypeScript's is. So the rule is per language, and it
is stated in `semantics/language.ts`:

| Language | `a / b` |
|---|---|
| TypeScript | a whole division when both sides are whole, a fractional one otherwise |
| Python | always a fractional division |

The resolver applies it: the type of the answer decides how the operands are
read, and a fractional answer reads two whole numbers as fractions.

Python's `//` is a floor division and has no spelling in the compiler at all.
It is a new operation, `floorDiv`, in the semantic IR
(`core/semantic-ir.ts`), lowered by the C, machine and wasm backends. It is
the truncating division with the answer moved down one when the remainder is
not zero and the two sides have different signs.

### The remainder takes the sign of the divisor

Python's `%` is a floored remainder: `-7 % 2` is 1, and the compiler's is a
truncated one, which is -1. So Python's `%` is a second new operation,
`floorMod`, in the same place as `floorDiv`: the truncated remainder with the
divisor added to it when the remainder is not zero and the two sides have
different signs.

The contract language has no `%` at all, so a Python function whose result is
`a % b` states no postcondition — see "Checking the program" below.

### A whole number beside a fraction is a fraction

Python has no such a thing as a whole number beside a fraction: `1 + 1.5` is
2.5 there, and the whole number is read as the fraction it is. The compiler's
program model refuses the pair, because TypeScript has no such a thing either:
`1n + 1.5` is a type error there, and a double holds a whole number exactly
only up to 2^53.

So the rule is per language, and it is stated in `semantics/language.ts` beside
the division and the remainder:

| Language | a whole number beside a fraction |
|---|---|
| TypeScript | refused: the two kinds of number are not mixed |
| Python | a fraction: the whole number is read as the fraction it is |

The resolver applies it in the one place every use passes through: a value
read where a fraction is expected, and the arithmetic of a pair that is not of
one kind. A promoted pair is answered at the width of the fraction, and the
answer is not a whole number, so it is written the way a fraction is written.

### The answer of a call keeps the kind of the number it was given

Python's `abs` of a whole number is a whole number, and `abs` of a fraction is
a fraction. The compiler's `Math.abs` answers a fraction either way, and the
two kinds of number print differently: `abs(-3)` is `3` in Python and `3.0` in
the compiler.

So the compiler has the whole numbers the answers are: `whole.abs`,
`whole.min`, `whole.max`, `whole.floor`, `whole.ceil` and `whole.trunc`, in
`semantics/builtins.ts`. They answer an `i64`, which is what says the answer
is a whole number and not a fraction, and they are lowered by the C backend
and by the driver of a program. The machine and the WebAssembly backends have
no whole number of their own and refuse them by name, as they refuse a floor
division.

The resolver applies the rule: a call of `Math.abs`, `Math.min` or
`Math.max` whose arguments are all whole numbers is answered by the whole one
in a language that says so, and by the fraction one otherwise. The conversions
of a program — `int(x)`, `math.floor(x)`, `math.ceil(x)` and `math.trunc(x)` —
answer a whole number in every language that has them, because that is what
they are for.

### A condition is a boolean

Python's truth is wider than a boolean: a number is false when it is zero, a
text is false when it is empty, a list is false when it holds nothing, and
`None` is false. The compiler's truth is narrower in the ways that matter:

| Value | Python | The compiler |
|---|---|---|
| `0` / `0.0` | false | false |
| `""` | false | false |
| `None` | false | false |
| `[]` | false | **true** — a list is a reference, and a reference that is there is true |
| `float("nan")` | **true** | false — a number that is not a number is not true |

So a condition in a Python program must be a boolean: a comparison, a
`not`, a name bound to a boolean, or a call that answers one. A condition
that is a number, a text, a list or `None` is refused with the message that a
condition has to be a boolean, and what to write instead (`x != 0`, `x is not
None`, `len(x) > 0`). This is a rule of the subset rather than a change to
the compiler: the truth of a value is decided in the backends
(`toolchain/ir-c.ts:684`), and a rule that is per language would have to
travel into every backend for a case the subset can refuse instead.

### A name is bound, and `None` is a value

Python has no `undefined`: a name that was never bound is an error, and
`None` is a value of its own. So:

- A name that is read before it is bound is a refusal, not a runtime check.
  The compiler's model binds a name where it is written and reads it after,
  and a program body that reads a name it did not declare is refused.
- `None` is a value: a comparison with it is `x is None`, which is not in
  the subset, so a program that wants to ask whether a value is nothing asks
  it of the reference it holds, which the compiler's `isNull` states.
- `__name__` is a name the frontend provides, as a text: `__main__`. It is
  what the guard every Python program is written with reads, so
  `if __name__ == "__main__":` is a comparison of two texts, and it is the
  entry module's statements that run either way. A module the program merely
  imports runs nothing, so the name is only ever read in the entry module,
  and the guard of an imported module is what says it runs nowhere else.

### The text of a value

A value is written as text in two places: in a `print` and in an f-string.
Python writes a number, a boolean and a null its own way, and the compiler
writes them its own:

| Value | Python | The compiler |
|---|---|---|
| `1.0` | `1.0` | `1` |
| `1e16` | `1e+16` | `10000000000000000` |
| `0.0001` | `0.0001` | `0.0001` |
| `0.00001` | `1e-05` | `0.00001` |
| `True` | `True` | `true` |
| `False` | `False` | `false` |
| `None` | `None` | `null` |
| `float("inf")` | `inf` | `Infinity` |
| `float("nan")` | `nan` | `NaN` |

A Python program that prints a float and a program that prints a boolean
would print something else from its source, so the runtime gains a **style**:
how a value is written as text. The style is a state the runtime holds, it is
set once when the program starts, and it is the source language that decides
which one it is:

- the JavaScript style is what the runtime writes today: a number in full
  from `1e-6` up to `1e21` and in exponential form outside it, a boolean as
  `true` or `false`, a null as `null`;
- the Python style is what Python writes: the shortest decimal that reads back
  as the value, in full from `1e-4` up to `1e16` and in exponential form
  outside it, an integral float written in full keeping its `.0`, a boolean
  as `True` or `False`, a null as `None`, and a value that is not finite as
  `inf`, `-inf` or `nan`.

The style is the runtime's own, so nothing downstream of it changes: the
driver sets it at startup, the harness of a function build sets it before it
calls the function, and every place the runtime writes a value as text — a
print, an f-string, a `str()` — writes it in the style that is set.

A list and a dict are not covered by either style: the runtime writes an
array as `[1,2]` and an object as JSON, and Python writes `[1, 2]` and
`{'a': 1}`. So **printing a list or a dict is refused** in a Python program
in this version, and the message says why.

### The arguments of the program

`sys.argv` is a list of texts in Python, and the compiler's arguments are
numbers: `blaze_rt_argv` answers the number an argument states
(`runtime/abi.ts:2382`). So:

- `sys.argv[0]` is the file the program runs, and the compiler's `argv[0]`
  is the program and its `argv[1]` is the file. So `sys.argv[i]` is the
  compiler's `argv[i + 1]`, and `len(sys.argv)` is the compiler's
  `argv_count` less one — the count of the arguments the program was given is
  the count of the compiler's, less the program and the file.
- An argument is a number, as it is in every other language the compiler
  reads, and so is the file: the file is not a number, and the slot it holds
  answers NaN. A program that wants an argument as a text has no way to ask
  for one in this version, and the message says so. A program that reads one
  as a number reads the number it states, as in `int(sys.argv[1])`.
- A file that reads the command line writes `import sys` as Python does. The
  command line is read by the program and not by a function of a module: a
  module is a library of functions, and a library reads no command line.

## Where a Python program is checked

A function is checked against its contract, which is a mathematical statement
about what it must compute. A program has no such statement: it is a sequence
of statements whose only observable effect is what it prints. So the build runs
the source on its own toolchain, runs the delivered binary, and compares the
two (`toolchain/verify-program.ts:153`).

**The toolchain of a Python source is `python3`.** The table that holds the
toolchain of a language (`toolchain/verify-program.ts:27`) becomes a table of
a command and the flags in front of the source, because the flags are the
toolchain's: `--experimental-transform-types` is node's, and a Python source
is run with none.

**A Python source needs no prelude.** The TypeScript source is run with a
prelude that gives it the `http` calls it uses and the `Deno.args` it reads;
a Python source uses no facility the compiler does not lower, so it is run as
it is.

**A Python function states a postcondition only when its body is one
expression.** The contract language is small: a number, a boolean, a null, a
name, an index, a call, a reduction, `!` and `-`, and the eight operators
`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&` and `||` with `+`, `-`, `*` and `/`. A
Python body that is a single `return` of an expression the contract language
has states `result == <that expression>`; a body that is anything else, or a
`return` of an expression the contract language has not (`a % b`, `a // b`,
`a ** b`, a conditional expression, a chained comparison), states none.

A function with no postcondition cannot be the entry of a library build — the
compiler refuses it (`semantics/program.ts:321`), because nothing can check
it on its own. It is still compiled as a part of a program, and the program is
the oracle for it.

**A function with a postcondition is checked with vectors, and the vectors are
not the program's buffers.** The checker builds inputs of the declared types
and asks whether the function answers what the contract says. A vector holds
the values the declared type allows, and the whole-number rewrite
(`semantics/whole-elements.ts`) reads the elements of a buffer as whole
numbers — which is the same number only where the elements are whole numbers.
So a function the checker runs with vectors is left as the source wrote it,
and the bodies written out into it as well. A Python function that states a
postcondition is such a function, and a Python function that does not is not:
what it reads is what the program wrote, and the rewrite is sound in it.

**The two runs must not share what the program writes.** A program that
writes a file and reads it back writes it in the source run and finds it
again in the binary run. This is the same rule the SQLite facility has, and
the same answer: a program that keeps its state in a file needs the harness
to give each run a directory of its own.

## What the compiler has to change

| File | What changes |
|---|---|
| `semantics/python.ts` | **new**: the tokenizer, the parser, the module analysis, and the contract of a Python function |
| `semantics/python-program.ts` | **new**: the statements of the entry module, as the program body |
| `semantics/language.ts` | **new**: the rules of a source language — the division, the floor, the remainder, the promotion of a whole number, the kind of the answer of a call, the truth of a value, the text of a value |
| `semantics/frontend.ts` | `frontendFor` answers the Python frontend for `python` and `py` |
| `core/types.ts` | the contract's type language has a `text`, which is the type of a string |
| `core/ir.ts` | the IR has a `//`, which is a floor division |
| `core/semantic-ir.ts` | two new operations: `floorDiv` and `floorMod` |
| `semantics/builtins.ts` | the whole numbers: `whole.abs`, `whole.min`, `whole.max`, `whole.floor`, `whole.ceil` and `whole.trunc`, and an argument of the command line is a number |
| `semantics/contract-build.ts` | a function named `main` is compiled under another symbol: `main` is the entry point of a C program, and a Python program is written with a `main` of its own |
| `semantics/ir-resolve.ts`, `semantics/ir-function.ts` | the arithmetic rules of the source language: a division of two whole numbers is a true division in Python, a remainder takes the sign of its divisor, a whole number beside a fraction is a fraction, and the answer of a call keeps the kind of the number it was given |
| `semantics/module.ts` | the whole-number kind of the program model is named for what it is, and a module says whether its body is the entry guard |
| `semantics/program.ts` | a module the program merely imports runs nothing, even when it holds the entry guard |
| `toolchain/ir-c.ts` | the two new operations, lowered, and the whole numbers beside them |
| `toolchain/driver.ts` | the whole numbers of a program, lowered beside the driver |
| `toolchain/ir-machine.ts`, `toolchain/ir-wasm.ts` | the two new operations are **not** lowered: a build that asks for them is refused by name |
| `runtime/abi.ts`, `runtime/nim.ts` | the style a value is written as text in, and the entry point that sets it |
| `toolchain/driver.ts`, `toolchain/program-emit.ts` | the driver sets the style when the program starts, and writes a boolean, a null and a whole number the way the language writes them |
| `toolchain/linker.ts` | the harness of a function build sets the style before it calls the function |
| `toolchain/verifier.ts` | a buffer named in a range is not a count: the vector planner gives a buffer a length of its own, and a count a range is written in terms of a count |
| `toolchain/verify-program.ts` | the toolchain of a language is a command and its flags, and `python3` is the toolchain of a Python source |
| `semantics/calls.ts`, `semantics/whole-elements.ts` | the whole-number rewrite leaves a function the checker runs with vectors alone, and the bodies written out into it |

### The rules of a language, in one place

The rules that differ between the languages are stated in one file,
`semantics/language.ts`, rather than spread through the resolver:

| Rule | TypeScript | Python |
|---|---|---|
| the division of two whole numbers | a whole division | a true division |
| the remainder | truncated | floored |
| a whole number beside a fraction | refused | a fraction |
| the answer of a call that takes a number | a fraction | the kind of the number it was given |
| the truth of a value | a number is false when it is zero, a text when it is empty, a reference when it is nothing | a condition is a boolean; the rest is refused |
| the text of a value | the JavaScript style | the Python style |

The resolver reads the language from the program contract
(`core/types.ts:253`, which already carries it) and from the function context
(`semantics/ir-function.ts:102`), so a rule that depends on the language is
asked of the language and not of the code that reads it.

## The rules a Python program lives within

These are the compiler's rules, and the subset is written to them. They are
here because they are the shape of what a Blaze program is.

- **A number is a number.** A whole number is sixty-four bits and a fraction
  is a double, and the two are not the same value: `1` and `1.0` are two
  numbers that print differently.
- **A function is declared before the functions that call it.** A function is
  settled by reading its body, and the body of a function that calls one
  settles that one first; a function declared after the one it calls is
  settled while that one is still being read, and the compiler refuses it as a
  function that calls itself.
- **A function of a program hands back a number or a reference, and not a
  text.** The text a function builds is written into a name of the program's
  own and read from there.
- **A program is written as C.** The driver of a program is C, and the
  functions a program declares are written out as C beside it. The machine
  backend lowers the functions of a *module*, so a Python program whose
  functions are all in the entry module is a C program, exactly as a
  TypeScript one is.
- **The state of a program lives in an array.** A name a function captures is
  a copy, and what it writes is not what the program sees.
- **A call that reads the world is not a value.** A call with an effect is not
  something the optimizer may compute twice or move.
- **A program is compared against its source by what it prints.** Nothing else
  about it is observable.

## Tests

- `test/python-frontend.test.ts` — the tokenizer and the parser: the
  indentation, the f-strings, the numbers, the refusals and the messages they
  carry, and the contract a Python function is given.
- `test/python-program.test.ts` — an end-to-end build of a Python program that
  prints what its source prints. The build's own verification against the
  source is the assertion, so the test asserts that the build succeeded and
  that the binary printed what the source prints.
- `test/python-semantics.test.ts` — the rules that differ, each with the
  program that shows them: a whole number, a true division, a floored
  division, a floored remainder, a whole number beside a fraction, the kind of
  the answer of a call, a boolean condition, and the text of a number, of a
  boolean and of `None`.
- `test/language-rules.test.ts` — the rules of a language are asked of the
  language: the same expression under two languages is two answers.

The suite runs each file as its own section (`test/run.ts`), so a new file is
a new section and needs nothing else.

## What is not done

- **No classes, no generators, no decorators, no comprehensions, no context
  managers, no pattern matching, no `async`.** Each is refused with the line
  it was written on.
- **No standard library.** A module of the project is a file of the project:
  `from helpers import dot` is the only import there is, beside the two
  modules of the standard library the compiler knows: `math` and `sys`. The
  operations the compiler has are written `math.floor(x)` and the rest, and
  `math` is a name the compiler knows and not a file of the project.
- **The whole numbers are sixty-four bits and Python's are not.** A program
  that overflows differs from its source, and the build catches it only where
  the value is printed.
- **A list is read only, and a list of what is not a number is refused.** A
  dict is an object, and its fields are read by `d["key"]`.
- **A condition is a boolean.** The wider truth of Python is not in the
  subset, and the message says what to write instead.
- **Printing a list or a dict is refused.** The two styles do not cover them.
- **Nothing is caught.** A compiled program cannot raise, so the block of a
  `try` that catches is read past and the block of a `finally` runs. A program
  that Python would have raised in prints what the compiled program prints, and
  the build says that the two disagree.
- **The arguments of a program are numbers.** A program that wants an
  argument as a text has no way to ask for one.
- **A module of the project is a file beside the entry file.** An import names
  a file of that directory by its name without the extension, and a dotted or
  a relative import is refused.
- **A Python function states a postcondition only when its body is one
  expression the contract language has.** A function whose body is more is
  compiled as a part of a program, and the program is the oracle for it. A
  body that divides states none either: the contract's division of two whole
  numbers is a whole division and Python's is not, so a contract that stated
  one would mean something else from the body.
- **The program body is written as C.** A Python program is a C program, in
  the way a TypeScript program is.
- **A power is not in the subset.** `a ** b` is refused: the compiler's power
  is a fraction and Python's is a whole number when both sides are whole, and
  the two are two numbers. A program writes the multiplication out.
- **The machine and the WebAssembly backends have no floor division.** The
  C backend has one, and a build that asks another backend for it is refused by
  name rather than answered with the truncating division it has. The whole
  numbers are refused by name there too: a whole number is a machine word and
  a double is not.
- **A whole operator is a whole operator.** `a % b` and `a // b` need whole
  numbers on both sides, as they do in the compiler, and a fraction beside one
  is refused rather than answered with the fraction Python answers it with.
- **The length of a value written out is not read.** `len("hello")` is
  refused: the compiler reads a length off the name it is written by, and a
  program writes the value into a name first.
- **The length of a list a function was given is carried with it.** `len(a)`
  where `a` is a list parameter is answered from the length that travels
  beside the pointer, so a function may read it directly instead of taking
  the length as a parameter of its own. The compiler's own backends carry it
  the same way, and a program that takes the length as a parameter is still
  compiled and checked.

### Open questions

- **Should a Python program's list be a buffer or a dynamic array?** A buffer
  is fixed and a dynamic array grows, and Python's list does both. The
  program model has both, and the subset picks the buffer for a literal: the
  list a program uses is the one it wrote out, and `a.append(x)` is not in the
  subset. A list that a loop fills is a question the subset does not answer
  yet, and a dynamic array is what would answer it.
- **Should the contract language grow a `%` and a `//`?** A Python function
  that returns a remainder states no postcondition today, and the contract
  language is what a postcondition is written in. The operators it has are
  the ones the compiler can state, and the floored remainder is one it would
  have to be taught.
- **Should the style be a state of the runtime, or a parameter of the call
  that writes a value?** It is a state of the runtime today, and the driver
  sets it once. A parameter would be in the ABI of every call that writes a
  value, which is a larger change than the branch the state costs on a path
  that is not hot.

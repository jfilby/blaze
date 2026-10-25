# Compiling Triton kernels

## What it is

Triton (openai/triton) is a language and a compiler for GPU kernels. A Triton
program is a Python function decorated with `@triton.jit`, and it reads and
writes blocks of data through pointers, offsets, strides and masks:

```python
@triton.jit
def add_kernel(x_ptr, y_ptr, output_ptr, n_elements, BLOCK_SIZE: tl.constexpr):
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    offsets = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offsets < n_elements
    x = tl.load(x_ptr + offsets, mask=mask)
    y = tl.load(y_ptr + offsets, mask=mask)
    output = x + y
    tl.store(output_ptr + offsets, output, mask=mask)
```

A kernel is launched from Python with a grid: `add_kernel[(grid,)](x, y,
output, n)`. The grid says how many program instances run, and each instance
runs one block of the data. Triton compiles the kernel through its own IR
(TTIR, TTGIR) to PTX (NVIDIA), and also supports AMD and Intel targets.

Triton is not a general-purpose language: its functions are kernels, its
values are blocks and scalars, its memory is device memory, and its control
flow is the control flow of one program instance over one block. The rest of
Triton — the grid launch, the JIT, the driver that compiles and launches — is
Python on the host.

## What compiling it means

Blaze compiles TypeScript (and Nim, and Python through the Python frontend)
into a native binary or a WebAssembly module. The source language is read by a
frontend, lowered into one IR, and one of three backends writes the target:
C, x86-64 machine code, or WebAssembly. Everything past the frontend is
language neutral.

So "compiling Triton" is not one change. It is every change between what Blaze
builds today and what a Python GPU-kernel language is. This document lists
those gaps: the language, the builtins, the value model, the grid launch, the
runtime, the target, and the oracle.

For each gap it says what the gap is, where in the compiler it would land, and
what is done and what is not. The last section states what is left out and the
open questions the work would have to answer.

## The parts

| Part | Where it goes | What it is |
|---|---|---|
| The language | `semantics/python.ts`, `semantics/python-program.ts` | the Python frontend and the subset of Python it reads; Triton is Python plus `@triton.jit`, `tl.*`, and the grid launch |
| The builtins | `semantics/builtins.ts` | the calls a kernel may make: `tl.load`, `tl.store`, `tl.program_id`, `tl.arange`, `tl.full`, `tl.where`, `tl.math.*`, and the rest |
| The language rules | `semantics/language.ts` | the arithmetic, the truth and the text a value writes, per source language |
| The value model | `semantics/module.ts`, `core/semantic-ir.ts` | a number, a text, an array, an object, a reference — and nothing that is a pointer, a block, or a mask today |
| The grid launch | none today | `kernel[grid](*args)`: how many program instances run, and which one this instance is |
| The runtime | `runtime/abi.ts`, `runtime/facil.ts` | the entry points the generated code calls, and the object they are linked beside |
| The backends | `toolchain/ir-c.ts`, `toolchain/ir-machine.ts`, `toolchain/ir-wasm.ts` | the lowering of the IR into C, x86-64 and WebAssembly |
| The driver and the link | `toolchain/driver.ts`, `toolchain/linker.ts`, `codegen.ts` | how a program is built, and what objects it is linked beside |
| The oracle | `toolchain/verify-program.ts` | the kernel runs under Triton and the delivered binary is compared against it |

## The gaps

### 1. The language is Python with things the subset refuses

Triton kernels are Python, so they start where the Python frontend starts: a
function with typed parameters and a declared return, `if` / `elif` / `else`,
`while`, `for ... in range(...)`, list and dict literals, f-strings. And they
keep going, into everything the subset refuses:

| Needed in the subset | Where Triton uses it |
|---|---|
| decorators (`@triton.jit`) | every kernel |
| `tl.load`, `tl.store` | every read and write |
| `tl.program_id`, `tl.num_programs` | which block this program instance owns |
| `tl.constexpr` | compile-time block sizes and shapes |
| `tl.full`, `tl.arange`, `tl.zeros`, `tl.ones` | building blocks |
| `tl.where` | masked selection |
| `tl.math.exp`, `tl.math.log`, ... | kernel math |
| `kernel[grid](*args)` | launching the kernel |
| pointers, offsets, strides, masks | how a kernel addresses data |
| `import triton` and `import triton.language as tl` | modules the compiler does not read |

These constructs must be implemented in the compiler for Triton kernels to compile. The Python frontend must accept them and lower them into a form the rest of the pipeline can handle. Named arguments in `tl.*` calls must be accepted (with positional mapping where the kernel calls are written). Each of `tl.load`, `tl.store`, `tl.program_id`, `tl.arange`, `tl.full`, `tl.where`, `tl.math.*`, and the grid launch `kernel[grid](...)` need implementations across the frontend, IR/value model, builtins, runtime, and backends as appropriate.

### 2. The builtins Triton calls do not exist

Triton's `tl` module is where a kernel lives: `tl.load` and `tl.store` read
and write device memory through a pointer with a mask, `tl.program_id` answers
which program instance this is, `tl.arange` and `tl.full` build blocks, and
`tl.math.exp` and the rest answer the math a kernel is made of. The compiler's
builtins are `len`, `range`, `abs`, `min`, `max`, `math.floor`, `math.ceil`,
`math.sqrt`, `math.trunc` — none of them a GPU-kernel operation.

A builtin the compiler lowers is a table entry with a C signature, and every
backend checks a call against its allowlist (`toolchain/ir-c.ts:176` for the C
backend, `toolchain/ir-machine.ts:1152` for the machine one). None of
`tl.load`, `tl.store`, `tl.program_id` or `tl.math.exp` is there, so a kernel
that calls them stops the build today.

### 3. The value model has no pointer, no block, no mask

A Triton value is a scalar, a block of scalars, a pointer into device memory,
an offset, a stride, or a mask. The compiler's value model is small: a number,
a text, an array, an object, a reference (`semantics/module.ts`). A number is a
double; a whole number is sixty-four bits; a text is held by the runtime; a
list is a read-only buffer; a dict is an object read by its key.

A Triton pointer is none of these, and neither is a block or a mask. Compiling
Triton means either teaching the value model pointers, blocks and masks, or
refusing every value it cannot hold.

### 4. The grid launch is host-side, and there is no host for it

`kernel[grid](*args)` is not a kernel statement: it is a Python call on the
host that JIT-compiles the function and launches it with a grid of program
instances. The host needs a Triton runtime: a JIT, a device, a stream, and a
launch. Blaze has no host like that: a program runs on one host — `"none"`,
`"nim"` or `"facil"` (`core/types.ts:388`) — and the runtime object is C
(`runtime/abi.ts`, bundled by `runtime/facil.ts:1432`).

The machine backend emits x86-64 machine code, not PTX or SASS. A build that
asks the machine backend for a symbol that is neither the runtime, nor the C
library, nor a function of the program is refused
(`toolchain/ir-machine.ts:1152`), so a call of `cudaLaunchKernel` or of a
triton-compiled kernel stops the build today.

### 5. The target is machine code for a CPU, and Triton targets a GPU

The machine backend (`toolchain/ir-machine.ts`) lowers the IR to x86-64
machine code and links it into an ELF object the runtime can call. The C
backend (`toolchain/ir-c.ts`) lowers to C and relies on a C compiler. The
wasm backend (`toolchain/ir-wasm.ts`) lowers to a WebAssembly module that
imports `env.memory`, `env.pow` and the host ABI, and nothing else.

Triton targets PTX, SASS, rocdl, and the Intel GPU backend — none of which any
Blaze backend writes. A Triton kernel compiled to x86-64 is not a Triton
kernel: it would be a CPU program that does the same arithmetic, and it would
not run on a device, in a block, with a mask.

## What the compiler has to change

| File | What changes |
|---|---|
| `semantics/python.ts` | the subset widens: decorators, `tl.*` calls, `tl.constexpr`, pointers, offsets, strides, masks |
| `semantics/python-program.ts` | the statements of the entry module grow to the same subset |
| `semantics/language.ts` | the rules of Triton: the truth of a mask, the text of a block, a pointer beside a number |
| `semantics/builtins.ts` | `tl.load`, `tl.store`, `tl.program_id`, `tl.num_programs`, `tl.arange`, `tl.full`, `tl.where`, `tl.math.*` |
| `semantics/module.ts` | a pointer kind, a block kind, a mask kind in the value model |
| `core/semantic-ir.ts` | new operations: a masked load, a masked store, a program-id, a block builder, a where |
| `core/ir.ts` | the IR gains the operations a kernel uses, or refuses them by name |
| `runtime/abi.ts` | the entry points a kernel calls: device memory, a launch, a stream |
| `runtime/` | a new facility, the shape of `runtime/http.ts` and `runtime/sqlite.ts`: a table of entry points, a header, an allowlist |
| `deps/` | vendored dependencies: a JIT, a device driver, a PTX or SASS emitter |
| `codegen.ts` | the preparer builds the kernel object and the runtime object when the program needs them |
| `toolchain/linker.ts` | the candidate and the program links take the kernel object beside the runtime object |
| `toolchain/driver.ts` | the program link takes the kernel object, the driver includes the kernel's header |
| `toolchain/ir-c.ts`, `toolchain/ir-machine.ts`, `toolchain/ir-wasm.ts` | the lowering of the new calls, and the refusal of the ones no target can carry (a wasm module links no library and no GPU) |
| `toolchain/verify-program.ts` | the oracle: the kernel runs under Triton on a GPU, and the delivered binary is compared against it |
| `core/types.ts` | the kind of a kernel a program launches beside its runtime, and the kind of a host a program with a GPU runs on |

### The effects of the calls

A kernel call reads device memory and writes device memory, and it answers a
block that is not the same on every turn — each program instance reads its own
block. Without the effects `filesystem`, `io` and `device`, the optimizer may
copy a call out of a loop (`semantics/repair.ts:409`) and mark a loop parallel
(`semantics/parallel.ts:358`). A grid loop whose condition reads the device
must not be hoisted, as the SQLite `step` loop was not
(`semantics/optimize-ir.ts:1157`).

## The rules a program compiled against it lives within

These are the compiler's rules, and Triton compiled against Blaze is written to
them:

- **A number is a number.** A whole number is sixty-four bits and a fraction is
  a double, and the two are not the same value. A block of half-precision
  numbers is not a number at all until the value model grows one.
- **A function of a program hands back a number or a reference, and not a
  block.** The block a kernel builds is written into a name of the program's
  own and read from there.
- **A kernel is compared against its source by what it prints.** Nothing else
  about it is observable. A kernel whose answer the source prints is checked
  against Triton, and the build says so when the two disagree.
- **A call that reads the world is not a value.** A kernel call has effects,
  and the contract states them.
- **Nothing is caught.** A compiled program cannot raise, so `try`/`except` is
  read past and `finally` runs, as the Python frontend already states.
- **A wasm program cannot use a kernel.** A wasm module links no library and no
  GPU, so the build refuses a program that launches a kernel rather than fail
  later at the link, as it refuses SQLite on wasm today.
- **A program hosted by Nim cannot use a kernel either.** The Nim host links
  the runtime and no kernel.

## Tests

- `test/triton-frontend.test.ts` — the Python frontend on a subset of Triton's
  source: a `@triton.jit` decorator, `tl.load`, `tl.store`, `tl.program_id`,
  `tl.arange`, `tl.math.exp` must be accepted and lowered by the frontend (with
  named arguments supported where used).
- `test/triton-program.test.ts` — an end-to-end build of a program that
  launches one kernel and prints its result, built and run. The build's own
  verification against the source is the assertion: the test asserts the build
  succeeded and that the binary printed what the source prints.
- `test/triton-runtime.test.ts` — the ABI table of the kernel facility, the
  header it generates, the allowlist, and that `isRuntimeSymbol` admits the
  kernel's symbols.

The suite runs each file as its own section (`test/run.ts`), so a new file is
a new section and needs nothing else.

## What is not done

- **The Python subset does not cover Triton.** Decorators, `tl.*`, `tl.
  constexpr`, pointers, blocks, masks, and the grid launch are refused by
  name. Widening the subset is a change to the frontend that has to be made
  for itself, not for Triton.
- **There are no Triton builtins.** `tl.load`, `tl.store`, `tl.program_id`,
  `tl.arange`, `tl.full`, `tl.where`, `tl.math.*` do not exist in
  `semantics/builtins.ts`, and no backend lowers them.
- **The value model has no pointer, no block, and no mask.** A Triton value
  is none of the compiler's values until the model grows one.
- **There is no grid launch.** `kernel[grid](*args)` is not in any subset, and
  no host runs it.
- **There is no GPU.** No device memory, no stream, no kernel launch, and no
  backend that emits PTX or SASS. A call of a GPU symbol is refused by name.
- **There is no oracle for a kernel.** Triton is not part of the build's
  toolchain, and comparing a binary against a Triton-compiled kernel requires
  a GPU in the loop, which is what makes it expensive.
- **A wasm program cannot use a kernel.** A wasm module links no library.
- **A program hosted by Nim cannot use a kernel.** The Nim host links the
  runtime and no kernel.

### Open questions

- **Should the kernel be an object beside the runtime, like SQLite?** SQLite
  showed the shape: one object built from vendored source, linked beside the
  runtime object in the candidate link and the program link
  (`toolchain/linker.ts`, `toolchain/driver.ts`). A kernel is tensors of code
  compiled by a JIT, not an object compiled from C, so the shape does not fit
  without a change — and the question should be answered rather than assumed.
- **Should a kernel run on GPU, or should a compiled program run the kernel on
  CPU?** Triton runs on GPU, and the compiler has no GPU. A CPU kernel is a
  smaller change but is not Triton.
- **Should the value model grow a pointer, a block, and a mask?** A pointer is
  an address into device memory, a block is a buffer with a shape and a type,
  and a mask is a buffer of booleans — and the value model has a read-only
  buffer and a dynamic array. None of them is any of those until the kernel
  says so.
- **Should the oracle run Triton's source with Triton and compare the binary
  against it?** The source is the specification, and Triton is part of the
  source's toolchain. That is a build with a GPU in the loop, which is what
  makes it expensive.
- **Is compiling Triton worth it at all?** Triton's value is the kernel, the
  grid, and the device — none of which the compiler has. Compiling its Python
  would not compile its kernel. The work that fits the compiler is the
  language and the facilities, and everything past them is a project of its
  own.

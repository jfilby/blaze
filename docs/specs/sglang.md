# Compiling SGLang

## What it is

SGLang (sgl-project/sglang) is a serving framework for large language models,
and a language for the structured generation those models answer with. It is
written in Python. A program built against it is a server: it accepts requests,
runs a model on GPU, and answers with generated text that follows a structure
the request asked for — a JSON object, a value that matches a regular
expression, a choice from a grammar.

SGLang is not one file. It is a Python project with a model server, a
structured-generation interpreter, a KV-cache manager (RadixAttention), a
scheduler that batches requests while they run, and bindings to a model
engine — today very often vLLM, with GGML and MLX on the side. Its dependencies
are the machine-learning stack: `torch`, `transformers`, `numpy`, and the async
and HTTP stack a server is built on (`asyncio`, `aiohttp`, `fastapi`, `uvicorn`).

## What compiling it means

Blaze compiles TypeScript (and Nim, and Python through the Python frontend) into
a native binary or a WebAssembly module. The source language is read by a
frontend, lowered into one IR, and one of three backends writes the target:
C, x86-64 machine code, or WebAssembly. Everything past the frontend is
language neutral.

So "compiling SGLang" is not one change. It is every change between what Blaze
builds today and what a Python LLM serving framework is. This document lists
those gaps: the language, the standard library, the value model, the runtime,
the model, the cache and scheduler, the structured generation, and the server.

For each gap it says what the gap is, where in the compiler it would land, and
what is done and what is not. The last section states what is left out and the
open questions the work would have to answer.

## The parts

| Part | Where it goes | What it is |
|---|---|---|
| The language | `semantics/python.ts`, `semantics/python-program.ts` | the Python frontend and the subset of Python it reads |
| The language rules | `semantics/language.ts` | the arithmetic, the truth and the text a value writes, per source language |
| The builtins | `semantics/builtins.ts` | the calls a program may make, and what each one answers |
| The standard library | `runtime/` and the vendored `deps/` | the facilities a program reaches for: `http`, `fs`, `crypto`, `JSON`, `Math`, `process` |
| The runtime | `runtime/abi.ts`, `runtime/facil.ts` | the entry points the generated code calls, and the object they are linked beside |
| The backends | `toolchain/ir-c.ts`, `toolchain/ir-machine.ts`, `toolchain/ir-wasm.ts` | the lowering of the IR into C, x86-64 and WebAssembly |
| The driver and the link | `toolchain/driver.ts`, `toolchain/linker.ts`, `codegen.ts` | how a program is built, and what objects it is linked beside |
| The model | none today | loading a model (GGML, safetensors) and running its tensors |
| The cache and the scheduler | none today | RadixAttention, continuous batching, the engine that serves requests |
| Structured generation | none today | regex- and grammar-constrained decoding |
| The server | none today | the HTTP server that answers LLM requests |

## The gaps

### 1. The language subset is a small Python, and SGLang is not it

The Python frontend (`semantics/python.ts`, `semantics/python-program.ts`)
reads a small subset: functions with typed parameters and a declared return,
counted loops over `range`, `if` / `elif` / `else`, `while`, `print`, list and
dict literals, f-strings, `math` and `sys`, and little else. The frontend for
`python` and `py` is registered in `semantics/frontend.ts:850`.

SGLang is written with everything the subset refuses:

| Refused in the subset | Where SGLang uses it |
|---|---|
| `class` | models, request objects, response objects, the server |
| `async` / `await` / `async def` | the serving loop and the request handlers |
| decorators | route registration and middleware |
| comprehensions | building batches and results |
| `with` | file and resource handling |
| `yield` and generators | streaming responses |
| `for x in a:` over anything but `range` | walking lists of requests |
| slices, negative indices | tensor and batch indexing |
| `*args`, `**kwargs`, default values | flexible APIs |
| `is`, `is not`, `in`, `not in` | identity and membership checks |
| `try` / `except` / `finally` (catching is read past) | error handling around model runs |
| `assert` | preconditions in the model code |
| `round` | it rounds half to even and the compiler rounds half up |
| `**`, `//`, `%` | these are supported; `**` is always floating, `//` is floor division, and `%` takes the sign of its divisor |

Every one of these is refused by name today, with the line it was written on
and what to write instead. Compiling SGLang means either widening the subset
until SGLang fits, or refusing SGLang's source and saying what to write
instead. The first is a project of its own; the second is what the compiler
already does for every program it cannot compile.

### 2. The standard library SGLang imports does not exist

SGLang imports `torch`, `transformers`, `numpy`, `asyncio`, `aiohttp`,
`fastapi`, `uvicorn`, `PIL`, and more. The compiler's facilities are `http`,
`fs`, `crypto`, `JSON`, `Math`, `process` — and `math` and `sys` in the Python
frontend. None of the machine-learning stack, the async stack, or the web
framework stack is there.

A facility the compiler lowers is a table in `runtime/abi.ts` — symbols with C
signatures, a header the table generates, and a symbol allowlist every backend
checks a call against (`toolchain/ir-c.ts:176` for the C backend,
`toolchain/ir-machine.ts:1152` for the machine one). A wasm module imports
nothing but the memory, `pow` and the host ABI (`toolchain/ir-wasm.ts:2868`),
so it reaches no facility at all outside the runtime.

To compile SGLang the compiler would need facilities for tensors, for
asynchronous I/O, and for an HTTP server that speaks the model's protocol — and
none of them exist today. `torch` alone is a project: tensors on CPU and on
GPU, autograd, the operators a model is made of.

### 3. The value model

A Python value is an object of dynamic type: a number, a text, a list, a dict,
a module, a tensor, a function. The compiler's value model is small: a number,
a text, an array, an object, a reference (`semantics/module.ts`). A number is a
double; a whole number is sixty-four bits; a text is held by the runtime; a
list is a read-only buffer; a dict is an object read by its key.

SGLang passes tensors around, passes models around, and holds request objects
whose fields the program reads by name. The compiler has no tensor, no model,
and no object whose fields are read by name except the dict-as-object of the
Python frontend, which is read only. Compiling SGLang means either teaching the
value model tensors and objects, or refusing every value it cannot hold.

### 4. The runtime and the host

The runtime Blaze links beside a program is C: `runtime/abi.ts` names the entry
points (allocation, printing, text, objects, arrays, exceptions, the clock, the
random source, the command line, files, hashing), and `runtime/facil.ts` bundles
them into one relocatable object the program is linked beside
(`runtime/facil.ts:1432`). A program runs on one host: `"none"`, `"nim"` or
`"facil"` (`core/types.ts:388`), and a library a program links beside its host
is the SQLite shape (`core/types.ts:399`, `deps/sqlite3`).

SGLang runs on GPU. Its runtime is CUDA: tensors in device memory, kernels
launched on streams, a model whose weights live in VRAM, and a KV cache that
grows as requests run. The compiler has no GPU, no device memory, no stream,
and no kernel. A build that asks the machine backend for a symbol that is
neither the runtime, nor the C library, nor a function of the program is
refused (`toolchain/ir-machine.ts:1152`), so a call of `cudaMalloc` or of a
cuBLAS kernel stops the build today.

The model SGLang serves is not a library the program links beside its runtime
in any sense the compiler knows: it is tensors of weights, a tokenizer, a
template, and a generation config, loaded from GGML or safetensors files. None
of that exists in `deps/` or in `runtime/`.

### 5. The model

SGLang's model is the largest gap of all. A model is:

- weights, tensors of half-precision numbers, gigabytes of them;
- a tokenizer, turning text into ids and ids back into text;
- a template, turning a prompt into the text the model was trained on;
- a generation config: temperature, top-p, max tokens, stop sequences;
- an engine that runs one forward pass at a time, on GPU, with a KV cache the
  requests share.

Blaze has none of it: no tensor type, no half-precision arithmetic the backends
lower, no file format reader for GGML or safetensors, no tokenizer, no template
engine, and no forward pass. A model is not lowered; it is loaded, and Blaze
does not load anything but the program itself.

### 6. The cache and the scheduler

SGLang's server does not run one request at a time. It batches requests that
are at the same step, shares their KV cache in RadixAttention (a radix tree of
cached keys and values), evicts when the cache is full, and preempts requests
that take too long. Continuous batching means a request arrives, joins a batch,
runs one token, leaves the batch, and the batch fills with the requests that
are ready.

The compiler has no cache, no scheduler, no preemption, and no batching at all
beyond what a program writes itself. A program that wants to batch writes a
loop, and the loop runs its turns in order unless it is marked parallel (OpenMP
in the C backend, a team of threads in the machine one, in order in wasm
— `toolchain/ir-wasm.ts` refuses nothing here but runs them in order).
There is nothing like RadixAttention, nothing like continuous batching, and
nothing like a server that accepts a request while another is still running.

### 7. Structured generation

SGLang's language constrains what a model may generate: a regex the answer
must match, a JSON schema it must conform to, a CFG it must derive. Constrained
decoding masks the model's vocabulary at every token so the answer follows the
structure, and it does it on GPU, in the kernel that samples the next token.

The compiler has no vocabulary mask, no sampler, no regex engine, no grammar,
and no GPU kernel to run any of them in. The text a program generates is the
text its own code prints; the model's answer is not something the compiler
knows how to produce at all.

### 8. The server

SGLang's server is an HTTP server: it accepts requests with a prompt and a
structure, runs them, and answers with generated text. It speaks the
OpenAI-compatible API, it streams answers token by token, and it keeps a
connection open while a request runs.

Blaze has an HTTP facility: `http.createServer` and the rest, lowered over
facil.io (`runtime/http.ts`), vendored at `deps/facil.io`. A program that uses
it is a native program that serves HTTP, and the build refuses it on wasm and
on Nim because neither host links the runtime object
(`toolchain/driver.ts`, `toolchain/linker.ts`).

But an LLM server is not the HTTP facility. It serves model requests, it
streams tokens, and it runs a model between the request and the answer. None of
that exists: no token stream, no model between request and answer, and no
OpenAI-compatible API. The HTTP facility is a building block, and the LLM
server is not.

## What the compiler has to change

| File | What changes |
|---|---|
| `semantics/python.ts` | the subset widens: classes, `async`/`await`, decorators, comprehensions, `with`, slices, `*args`/`**kwargs`, defaults, `try`/`except`, `assert`, `round`, `**`, `//`, `%` |
| `semantics/python-program.ts` | the statements the entry module runs grow to the same subset |
| `semantics/language.ts` | the rules of Python grow with the subset: the truth of an object, the text of a value, the division and the remainder of numbers that are not the compiler's |
| `semantics/builtins.ts` | the calls a program may make: `torch.*`, `numpy.*`, `asyncio.*`, `aiohttp.*`, and the model's own calls |
| `runtime/abi.ts` | the entry points a model and a server call: tensors, device memory, kernels, streams, the KV cache, the sampler |
| `runtime/` | a new facility, the shape of `runtime/http.ts` and `runtime/sqlite.ts`: a table of entry points, a header, an allowlist |
| `deps/` | vendored dependencies: a tensor library, a tokenizer, a model format reader |
| `codegen.ts` | the preparer builds the model object and the runtime object when the program needs them |
| `toolchain/linker.ts` | the candidate and the program links take the model object beside the runtime object |
| `toolchain/driver.ts` | the program link takes the model object, the driver includes the model's header |
| `toolchain/ir-c.ts`, `toolchain/ir-machine.ts`, `toolchain/ir-wasm.ts` | the lowering of the new calls, and the refusal of the ones no target can carry (a wasm module links no library and no GPU) |
| `toolchain/verify-program.ts` | the oracle: the source runs on `python3` with `torch`, and the delivered binary is compared against it |
| `core/types.ts` | the kind of a model a program loads beside its runtime, and the kind of a host a program with a GPU runs on |

### The effects of the calls

A model call reads the world: it reads device memory, it writes the KV cache, it
answers a token that is not the same on every turn. Without the effects
`filesystem` and `io` (and a new one, `device`), the optimizer may copy a call
out of a loop (`semantics/repair.ts:409`) and mark a loop parallel
(`semantics/parallel.ts:358`). A generation loop whose condition reads the
cache must not be hoisted, as the SQLite `step` loop was not
(`semantics/optimize-ir.ts:1157`).

## The rules a program compiled against it lives within

These are the compiler's rules, and SGLang compiled against Blaze is written to
them:

- **A number is a number.** A whole number is sixty-four bits and a fraction is
  a double, and the two are not the same value. A tensor of half-precision
  numbers is not a number at all until the value model grows one.
- **A function of a program hands back a number or a reference, and not a
  text.** The text a function builds is written into a name of the program's
  own and read from there.
- **A program is compared against its source by what it prints.** Nothing else
  about it is observable. A server whose answer the source prints is checked
  against `python3` with `torch`, and the build says so when the two disagree.
- **A call that reads the world is not a value.** A model call has effects, and
  the contract states them.
- **Nothing is caught.** A compiled program cannot raise, so `try`/`except` is
  read past and `finally` runs, as the Python frontend already states.
- **A wasm program cannot use a model.** A wasm module links no library and no
  GPU, so the build refuses a program that loads a model rather than fail later
  at the link, as it refuses SQLite on wasm today.
- **A program hosted by Nim cannot use a model either.** The Nim host links the
  runtime and no model.

## Tests

- `test/sglang-frontend.test.ts` — the Python frontend on a subset of SGLang's
  source: a class, an `async def`, a decorator, a comprehension, each refused
  by name with the line it was written on.
- `test/sglang-program.test.ts` — an end-to-end build of a program that loads a
  model and generates one token, built and run. The build's own verification
  against the source is the assertion: the test asserts the build succeeded and
  that the binary printed what the source prints.
- `test/sglang-runtime.test.ts` — the ABI table of the model facility, the
  header it generates, the allowlist, and that `isRuntimeSymbol` admits the
  model's symbols.

The suite runs each file as its own section (`test/run.ts`), so a new file is a
new section and needs nothing else.

## What is not done

- **The Python subset does not cover SGLang.** Classes, `async`, decorators,
  comprehensions, `with`, slices, and the rest are refused by name. Widening
  the subset is a change to the frontend that has to be made for itself, not
  for SGLang.
- **There is no tensor library, no tokenizer, and no model format reader.** A
  model is not loaded, and the weights, the KV cache and the forward pass do
  not exist in `deps/` or in `runtime/`.
- **There is no GPU.** No device memory, no stream, no kernel, and no backend
  that emits one. A call of a CUDA symbol is refused by name.
- **There is no cache and no scheduler.** RadixAttention, continuous batching
  and preemption do not exist, and a server that accepts a request while
  another runs cannot be built.
- **There is no structured generation.** No vocabulary mask, no sampler, no
  regex engine, and no grammar.
- **There is no LLM server.** The HTTP facility exists, but token streaming,
  the model between request and answer, and the OpenAI-compatible API do not.
- **A wasm program cannot use a model.** A wasm module links no library.
- **A program hosted by Nim cannot use a model.** The Nim host links the
  runtime and no model.

### Open questions

- **Should the model be a library beside the runtime, like SQLite?** SQLite
  showed the shape: one object built from vendored source, linked beside the
  runtime object in the candidate link and the program link
  (`toolchain/linker.ts:659`, `toolchain/driver.ts:1560`). A model is tensors
  of weights loaded from a file, not an object compiled from C, so the shape
  does not fit without a change — and the question should be answered rather
  than assumed.
- **Should a model run on GPU, or should a compiled program run the model on
  CPU?** SGLang runs on GPU, and the compiler has no GPU. A CPU model is a
  smaller change but is not SGLang.
- **Should the value model grow a tensor?** A tensor is a buffer of numbers
  with a shape and a type, and the value model has a read-only buffer and a
  dynamic array. A tensor is neither until the model says so.
- **Should the oracle run SGLang's source with `torch` and compare the binary
  against it?** The source is the specification, and `torch` is part of the
  source's toolchain. That is a build with a GPU in the loop, which is what
  makes it expensive.
- **Is compiling SGLang worth it at all?** SGLang is a Python project whose
  value is the model, the cache and the scheduler — none of which the compiler
  has. Compiling its Python would not compile its model. The work that fits the
  compiler is the language and the facilities, and everything past them is a
  project of its own.

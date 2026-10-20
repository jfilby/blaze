# The WebAssembly backend

## What it is

A Blaze project can be built as a WebAssembly module today. `output: "wasm"`
(or `--output wasm`) resolves the function's semantic IR, lowers it to a
module the compiler writes itself — byte by byte, with no `wat2wasm` and no
text form — and delivers it beside the IR it was built from.

| Part | Where | What it is |
|---|---|---|
| the lowering | `src/compiler/toolchain/ir-wasm.ts` | semantic IR → module bytes |
| the host ABI | `src/compiler/toolchain/wasm-host-runtime.ts` | the table of imports, and the runtime the host carries |
| the host and the boundary | `src/compiler/toolchain/wasm.ts` | the argument mapping, the boundary check, the host that runs the module |
| the legacy path | `toolchain/wasm.ts: buildWasm` | WAT text through `wat2wasm`; a build no longer takes it |

The module boundary is narrow, and deliberately so. A module:

- imports `env.memory` (the host's linear memory), `env.pow`, and the
  services of the host ABI its body reached for, and nothing else;
- exports the contracted symbol and `__blaze_data_base`, the first address
  above everything the module owns;
- exports no `memory` and no `_start`.

The argument mapping is the ABI:

| Contract type | Carried as |
|---|---|
| `bool`, `i8`, `i16`, `i32`, `u8`, `u16`, `u32` | `i32` |
| `i64`, `u64`, `usize`, `isize` | `i64` |
| `f32`, `f64` | themselves |
| a buffer, a slice, an array, a reference | `i32`, a byte offset into the imported memory |
| a text | refused by name — the vector protocol carries a buffer and not a text |

The count of a buffer is the 8-byte word at `pointer - 8`; the host writes it
before it calls the module, because a module is handed a pointer to the
elements and no length beside it.

The host (`generateWasmHost`, `toolchain/wasm.ts`) is a generated `.mjs`
that reads the same vector protocol on standard input as the native C harness,
places the buffers in the module's memory, calls the export, and prints
`RESULT …` and `BENCH …` in the same format. Because the protocol is the
same, `toolchain/verifier.ts` and `toolchain/benchmark.ts` work on a wasm
build without knowing there is one.

The host is also the runtime: it carries the implementations of the services
the module reached for, in JavaScript, over the same linear memory the module
reads and writes. The managed representation is the one the C runtime uses — a
forty-eight byte header, a payload, a reference count — so a value the module
holds and a value the host holds are the same kind of thing.

What it is not: a second compiler for a different machine. It is the same IR,
the same contract, the same vectors, and the same proofs, carried into a
format that has no C compiler to carry them.

## What "the same degree" means

The C backend and the machine backend are two lowerings of the same IR into
two formats that both have a toolchain underneath them. The wasm backend is
the third lowering, into a format that has none. "The same degree" is then
not "the same instructions" — it is six things:

1. **The language surface.** Every construct the IR can hold lowers to
   something, or is refused *by name*, with a reason that says what to build
   instead. A refusal is allowed; a silent difference is not. A module that
   answers a different number than the C backend answers the same program is
   worse than a module that refuses to be built.
2. **The runtime services.** The same runtime ABI (`runtime/abi.ts`) that the C
   backend calls and the machine backend calls: allocation, printing, text,
   objects, arrays, exceptions, the clock, the random source.
3. **The program.** A program has several functions, a body, and a driver that
   calls them. A wasm build of a program has to produce one module that holds
   them all and an entry that runs the body. **Not done.**
4. **The module's own functions.** A function that calls another function of
   the program has to be lowered into a call of that function, in the same
   module. **Not done.**
5. **The review artifact.** The machine backend hands a review a listing of
   the object (`describeMachineObject`, `toolchain/ir-machine.ts:8239`). A
   review of a wasm module gets a listing of it (`describeModule`,
   `toolchain/ir-wasm.ts`): the sections, the types, the imports, the exports,
   the globals, and the code section decoded into instructions with their
   immediates read back.
6. **The proof.** Verification against the vectors, the liveness probe for a
   definition contract, and the benchmark. All three run on a wasm build.

## Where the wasm backend stands

| | C backend | machine backend | wasm backend |
|---|---|---|---|
| arithmetic over `i32`/`i64`/`f32`/`f64` | yes | yes | yes |
| unsigned division, remainder and ordering | yes | yes | yes |
| shifts, bitwise operators | yes | yes | yes |
| floor division and floored remainder | yes | yes | **refused** |
| a power (`**`) | yes (`pow`) | yes | yes, over `f64` (`env.pow`) |
| a compound power (`**=`) | yes | yes | yes, over `f64`; the answer is converted to the slot's type |
| whole-number builtins (`whole.abs`, `whole.min`, …) | yes | yes | yes |
| `Math.random` | yes | yes | yes |
| a 256-bit whole number: add, subtract, bitwise, shift | yes | yes | yes |
| a 256-bit whole number: multiply, divide, remainder | yes | yes | yes, as calls of the kernel |
| a 256-bit whole number: ordered comparison | yes | yes | yes |
| `u256_from_u64x2`, `u256_from_u64x4` | yes | yes | yes, as calls of the kernel |
| text, string concatenation | yes | yes | yes |
| the comparison of two texts | yes (`strcmp`) | yes (`strcmp`) | yes, as a call of the runtime's own |
| printing | yes | yes | yes |
| allocation, arrays, objects | yes | yes | yes |
| dynamic values and dynamic arrays (`array.new`, `JSON.parse`, …) | yes, in a program | yes, in a program | yes |
| hashing and reading a file | yes, in a program | yes, in a program | yes |
| exceptions (`raise`, `retain`, `release`) | yes | yes | yes |
| the command line (`process.argv`) | yes | yes | yes |
| a call of another function of the program | yes | yes | **refused** |
| a loop marked parallel | OpenMP | a team of threads | **runs in order** |
| a program (several functions and a body) | yes | yes, or the C backend takes it | **refused** |
| HTTP (`http.requestPath` and the rest) | yes | yes | **refused** |
| SQLite | yes | yes | **refused** |
| JSON, files, hashing, `fetch` | yes | yes | `fetch` is **refused**; the rest are yes |
| the liveness probe of a definition contract | yes | yes | yes |
| the artifact a review reads | the C, or the assembly | a listing of the object | a listing of the module |
| the folds the backend knows are safe | the C compiler's | the backend's own | the backend's own |

## The gaps

### The language surface refused today

Every one of these is a refusal by name, raised in `toolchain/ir-wasm.ts` —
through `unreachable` for most of them, and through the lowering's own errors
for the builtins and the wide arithmetic — and every one of them is a program
the C or the machine backend builds:

| Refused | Where |
|---|---|
| a call of another function of the program | `ir-wasm.ts:1626`, `ir-wasm.ts:2782` |
| a floor division, a floored remainder | `ir-wasm.ts:1603` |
| a conversion between two carriers the format has no instruction for | `ir-wasm.ts:1102` |
| the length of something that is not a buffer | `ir-wasm.ts:1252` |
| a field of a layout the module does not know | `ir-wasm.ts:1288`, `ir-wasm.ts:2718` |
| a new object of a layout the module does not know | `ir-wasm.ts:1344`, `ir-wasm.ts:1356` |
| an element of something that is not a buffer | `ir-wasm.ts:2663` |
| a view of a block of bytes | `ir-wasm.ts:1303` |
| a JSON of something that is not a text | `ir-wasm.ts:3262` |

Three more refusals live outside the module: a wasm build may not link a
runtime (`compiler.ts:325`), may not use SQLite (`compiler.ts:1119`), and a
program may not be built as wasm at all (`compiler.ts:940`).

The HTTP calls, `fetch` and `process.exit` are refused as well: they are calls
of a host process rather than services of the runtime, and the host ABI is the
runtime's.

### What was wrong rather than refused, and is not now

These were not gaps in reach; they were answers that are wrong, and they were
worse than a refusal. Each of them is fixed, and each of them has a test.

1. **A `fill` statement is dropped by every backend.** The statement switch
   of the C backend (`ir-c.ts:398`), of the machine backend (`ir-machine.ts:3263`)
   and of the wasm backend (`ir-wasm.ts:2073`) has no case for the IR's `fill`
   statement, and none of the three has a default arm that refuses it, so a
   fill is silently not written. The resolver produces one only for a program
   body (`semantics/ir-resolve.ts:4487`), and a program body is also emitted
   by the driver that runs it (`toolchain/program-emit.ts:747`), so a build
   does not normally reach a backend with one — but the IR text form prints
   and parses a fill (`semantics/ir-text.ts:570`), so a review round that
   writes one produces a candidate that is accepted, validated, and silently
   does nothing. The fix belongs in the IR rather than in one backend: the
   validator should refuse a statement no backend lowers, or all three should
   lower it. The wasm backend writes it out as the walk it is, and the C
   backend refuses it by name rather than dropping it.

2. **`**=` on a slot that is not a float is an invalid module.** The `set`
   arm writes the old value, the new value, and then calls `env.pow`, which
   takes two `f64` and hands back an `f64` (`ir-wasm.ts:2095`). The values on
   the stack are the slot's own type, so a `u64` slot calls `env.pow` with two
   `i64`, and the engine refuses the module: "call[0] expected type f64, found
   local.get of type i64". The C backend truncates the answer into the slot
   (`pow(x, v)` in `ir-c.ts:428`), so the two backends answer differently: one
   a number, one a module the engine refuses. The fix is to convert both
   operands to `f64` before the call and to convert the answer back to the
   slot's type after it. It is done.

3. **A text parameter fails the host generator rather than being refused.**
   `generateWasmHost` asks `bufferElement` for the element type of every
   non-primitive parameter (`toolchain/wasm.ts:327`), and `bufferElement`
   throws "text is not a buffer" for a text (`semantics/contract.ts:200`). A
   contract with a text parameter is a legal contract, and the wasm build of
   it stops with an error about a buffer rather than a refusal that names the
   parameter. (A text *return* is refused cleanly, with "return type text is
   not supported for wasm"; it is the parameter that is not.) The parameter is
   refused by name now.

4. **A float that does not fit the whole number it is written into traps.**
   WebAssembly's `i32.trunc_f64_s` traps on a value outside the range; C's
   cast of the same value is undefined. The two backends answer differently
   for the same source, and the wasm one answers with a trap that the verifier
   reads as a failure of the candidate rather than as a difference between the
   backends. The rule the language states has to be named and both backends
   have to answer it the same way.

### The runtime services

The C backend emits calls of `blaze_rt_*` and the runtime is linked beside
the object. The machine backend emits calls of the same symbols and the
runtime is linked beside its object. The wasm backend emits a module that
reaches the runtime through the host ABI, and the host carries the runtime:
the services a module reaches for are the ones the host implements, over the
same linear memory the module reads and writes.

That was the single largest gap, and everything else that refused a runtime
service was a consequence of it. The runtime ABI (`runtime/abi.ts:77`) is
fifty-nine entries; the ones a wasm module needs to be as useful as a C
object are:

| Service | What it is |
|---|---|
| `allocate`, `allocate_uninitialized`, `release`, `retain` | the heap |
| `print_text`, `print_text_n`, `print_number`, `print_whole`, `print_newline` | the output |
| `raise` | the exception |
| `to_text`, `to_number`, `format_number`, `format_number_fixed` | text and numbers |
| `string_new`, `string_append`, `string_length`, `text_length` | text |
| `text_compare` | the comparison of two texts |
| `array_new`, `array_push`, `array_get`, `array_set`, `array_length` | dynamic arrays |
| `object_new`, `object_size` | objects |
| `random`, `monotonic_ms` | the clock and the random source |
| `argv_count`, `argv` | the command line |
| `json_parse`, `json_stringify`, `json_get` | dynamic values |
| `md5_create`, `md5_update`, `md5_digest`, `file_read` | the file and the hasher |

### The program

A program is refused (`compiler.ts:940`) because a program is linked from
native objects. A wasm program is not linked from anything: a module holds
its own functions and calls them directly, which is the one thing the format
makes easier than a native binary. What is missing is the plumbing:

- `compilationUnits` compiles one unit per function for a program and the
  build links them; a wasm build has to lower them into **one** module.
- the body of a program is a sequence of statements, not a function; it has to
  become the module's entry.
- the driver the C backend writes (`toolchain/program-emit.ts`, the linker) is
  a C program; the wasm one is the host.

### The calls between the functions of a program

A function that calls another function of the program is refused
(`ir-wasm.ts:1626`). The IR of every function of the program is already in
the build (`CodegenRequest.functions`), and a module can hold every function
and call them with a `call` instruction — there is no linker and no symbol
table. So this is not a hard problem; it is a question of what a module holds
and how a call names the function it names.

What a module that holds several functions needs is written down here, because
it is the part of the design that is not in the code yet:

- **The state a module shares.** The pooled constants (the floats that are read
  out of a global, the wide numbers and the texts that are laid down in the
  data segment) and the services the module imports are the module's, not a
  function's: two functions of one module read the same global and the same
  text. The body that writes a function owns today (`pooledFloats`,
  `pooledWides`, `pooledTexts`, `services`) is the state of the module, and
  the state of a function is what is left (its own bytes, its own locals, its
  own labels).

- **The scratch of the wide numbers.** The limbs of a wide number in flight
  are scratch, and the scratch of one function cannot be the scratch of
  another: a function that computes a wide number and then calls a function
  that computes one as well would have the second one write over the first.
  The scratch is therefore a region of its own per function, and the constants
  are laid down above every one of them.

- **The constants are one list.** The wide numbers and the texts are laid down
  one after another, and each is at the address the ones before it leave free.
  Two lists put a text and a wide number at the same address when the text
  was pooled first, which is a bug the backend had and does not have now.

- **The index of a call.** The module numbers its functions after the imports
  it has, and a call of another function of the program is a `call` of that
  index. The IR of the call carries the signature of the callee, so the
  arguments are converted to the types the callee takes and the answer is
  converted back to the type the call was written at.

### The review artifact

A review of a module reads `describeModule` (`ir-wasm.ts:2758`): the size of
each section and the exports. The machine backend hands its review a listing
of the object — the instructions a processor would run — and the C backend
hands its review the C or the assembly it wrote. A module has no text, so
something has to decode it. Writing a disassembler for the code section is
the same work `describeMachineObject` does for an object, and it is what makes
a review of a module worth asking for.

### The proof

The verifier and the benchmark work on a wasm build: the host speaks the same
protocol. The liveness probe works as well: a definition-contract candidate is
called once through the host (`toolchain/probe.ts`), so a candidate that traps
on every input is refused as a candidate.

The host is delivered beside the module, and the reuse list names it: a module
nobody can run is not a deliverable.

### The output quality

The C backend compiles with the C compiler's optimisation; the machine backend
writes optimized x86-64. The wasm backend folds what it writes, with the folds
it knows are safe, and the folds are named under "Stage 8" below.

## The design

### The host ABI

The module reaches the host through a **host ABI**: a table of imports, each
one the name of a runtime service and its WebAssembly signature. The module
imports the services its body uses and nothing else, so a module of arithmetic
still imports only the memory.

The table lives beside the ABI it mirrors, in `toolchain/wasm-host-runtime.ts`.
It is the runtime ABI (`runtime/abi.ts:77`) with the C types replaced by the
WebAssembly ones: a pointer is an `i32` offset into the shared memory, a
`size_t` is an `i64`, a `double` is an `f64`, and a `const char*` is an `i32`
offset of the bytes of the text.

```
env.memory                                  the linear memory
env.pow                                    (f64, f64) -> f64
env.blaze_rt_allocate                       (i64) -> i32
env.blaze_rt_allocate_uninitialized         (i64) -> i32
env.blaze_rt_reallocate                     (i32, i64) -> i32
env.blaze_rt_retain                         (i32) -> i32
env.blaze_rt_release                        (i32) -> ()
env.blaze_rt_print_text                     (i32) -> ()
env.blaze_rt_print_text_n                   (i32, i64) -> ()
env.blaze_rt_print_number                   (f64) -> ()
env.blaze_rt_print_whole                    (i64, i32) -> ()
env.blaze_rt_print_newline                  () -> ()
env.blaze_rt_raise                          (i32) -> ()      the host throws
env.blaze_rt_to_text                        (f64) -> i32
env.blaze_rt_to_number                      (f64) -> f64
env.blaze_rt_format_number                  (f64, i32, i64) -> i64
env.blaze_rt_format_number_fixed            (f64, i32, i32, i64) -> i64
env.blaze_rt_string_new                     (i32, i64) -> i32
env.blaze_rt_string_append                  (i32, i32) -> i32
env.blaze_rt_string_clone                   (i32) -> i32
env.blaze_rt_string_length                  (i32) -> i64
env.blaze_rt_text_length                    (i32) -> i64
env.blaze_rt_text_compare                   (i32, i32) -> i32
env.blaze_rt_object_new                     (i64, i64) -> i32
env.blaze_rt_object_size                    (i32) -> i64
env.blaze_rt_array_new                      (i64, i64) -> i32
env.blaze_rt_array_resize                   (i32, i64, i64) -> i32
env.blaze_rt_array_push                     (f64, f64) -> f64
env.blaze_rt_array_get                      (f64, f64) -> f64
env.blaze_rt_array_set                      (f64, f64, f64) -> ()
env.blaze_rt_array_length                   (f64) -> f64
env.blaze_rt_dyn_array_new                  () -> f64
env.blaze_rt_box_number                     (f64) -> f64
env.blaze_rt_box_string                     (i32) -> f64
env.blaze_rt_box_null                       () -> f64
env.blaze_rt_random                         () -> f64
env.blaze_rt_monotonic_ms                   () -> f64
env.blaze_rt_argv_count                     () -> i64
env.blaze_rt_argv                           (i64) -> f64
env.blaze_rt_json_parse                     (i32) -> f64
env.blaze_rt_json_stringify                 (f64) -> f64
env.blaze_rt_json_get                       (f64, i32) -> f64
env.blaze_rt_md5_create                     () -> f64
env.blaze_rt_md5_update                     (f64, i32) -> f64
env.blaze_rt_md5_digest                     (f64) -> f64
env.blaze_rt_file_read                      (i32, i32) -> f64
env.blaze_rt_u256_from_u64                  (i32, i64) -> ()
env.blaze_rt_u256_from_u64x2                (i32, i64, i64) -> ()
env.blaze_rt_u256_from_u64x4                (i32, i64, i64, i64, i64) -> ()
env.blaze_rt_u256_mul                       (i32, i32, i32) -> ()
env.blaze_rt_u256_div                       (i32, i32, i32) -> ()
env.blaze_rt_u256_mod                       (i32, i32, i32) -> ()
env.blaze_rt_u256_add_mod                   (i32, i32, i32, i32) -> ()
env.blaze_rt_u256_sub_mod                   (i32, i32, i32, i32) -> ()
env.blaze_rt_u256_mul_mod                   (i32, i32, i32, i32) -> ()
env.blaze_rt_u256_less                      (i32, i32) -> i32
env.blaze_rt_u256_equal                     (i32, i32) -> i32
env.blaze_rt_print_u256                     (i32) -> ()
```

The names are the runtime's own, so the mapping from the runtime ABI is one to
one and the machine backend's spelling of a call carries over unchanged.
`blaze_rt_raise` is the one the ABI already marks as never returning
(`runtime/abi.ts`), and the host throws where the C runtime does not come
back.

The `u256_*` services are not the runtime ABI but the kernel beside it: a
module has no instruction that carries a two hundred and fifty six bit number,
so it calls the kernel the other two backends call.

Two services are not the C signature with its types replaced, and both are
because the C ABI carries a pointer through a double where the WebAssembly ABI
has a pointer of its own. `blaze_rt_json_parse` takes the text as the offset
of its bytes, and the counts of `blaze_rt_array_get`, `blaze_rt_array_set` and
`blaze_rt_array_length` are doubles, because the runtime carries a count as a
double on the side of the wall the dynamic values live on.

Three rules hold the boundary together:

1. **The module imports what the ABI table says and nothing else.** The
   boundary check (`boundaryProblems`, `toolchain/wasm.ts:183`) stops being a
   count of two imports and becomes a check that every import is in the table,
   that the memory is imported, and that the module exports no `memory` and no
   `_start`.
2. **The host implements every service the table names.** The host is
   generated, so it carries the implementations with it; a service the module
   did not import is not implemented and not paid for.
3. **The host is the runtime.** The wasm runtime is JavaScript, in the
   generated host, and it is the wasm counterpart of `runtime/abi.ts`. The
   managed representation (a 48-byte header, a payload, a reference count) is
   the same one the C runtime uses, so a value the module holds and a value
   the host holds are the same kind of thing.

### Memory

The memory is the host's, and the host's allocator is the one that hands out
memory. A module therefore never grows the memory itself and never writes
below `__blaze_data_base` except into its own scratch: the wide-number limbs
live at the low addresses the backend reserves, the pooled constants live
above them, and the host starts handing out memory at the address the module
publishes. A buffer the host passes in is laid out the way the C runtime lays
one out, at the width of its element, with the count in the word before it.

A wide number is the one thing that does not come from the host: it is four
64-bit limbs in the module's own scratch, and the arithmetic over it is
written out limb by limb. That stays.

### Text

A text is a byte offset into the memory, and the runtime's string operations
are host calls. The C backend builds a text with `blaze_rt_string_new` and
concatenates with `blaze_rt_string_append`; the wasm backend emits the same
calls as imports, with the payload written into the module's own memory first
and the offset handed over. The `toText` of a number is `to_text` of a boxed
number, which is what the C backend does as well.

The one thing that has to be decided is what a text *parameter* of a contract
means. In the C ABI a text parameter is a `char*` the caller owns. In the wasm
ABI it is a byte offset into the shared memory, and the host has to write the
bytes there before it calls the module — the same way it lays out a buffer.
That is a change to `generateWasmHost` and to the ABI table, and it is what
makes a text parameter work instead of crashing the host generator.

### Objects, arrays and dynamic values

An object is a fixed layout, and the C backend allocates it from the runtime
and writes its fields at the offsets of the layout. The wasm backend does the
same: `object_new` is a host call, and the fields are written at their
offsets, which is what `storeField` already does.

A dynamic array and a dynamic value are the runtime's own representation
carried in a `f64` handle, exactly as the C backend carries them. The wasm
backend emits the same calls as imports.

### Exceptions

`raise` is a host call, and the host implements it by throwing — which unwinds
the whole module, so the call does not come back. WebAssembly has no way of
saying that a call never returns: the format has no such annotation on a
function type, and the text format's `noreturn` is not in the binary one. So
the lowering says it itself: the instruction after the call is an
`unreachable`, the same one the IR's own `unreachable` terminator emits, which
traps if control ever reaches it. The module stays valid either way — the
engine does not know the call does not come back, so the code after the raise
is reachable as far as it is concerned, and whatever that code needs on the
stack has to be there.

`retain` and `release` are host calls like any other. The reference counts
live in the host's memory, so the counting is the runtime's counting.

### Whole numbers at 256 bits

The wide arithmetic the backend has — add, subtract, the bitwise operators,
the shifts, the equality — is written out limb by limb and is correct. What
is missing is what the format has no instruction for:

- **a multiply.** There is no `mulhi`, so a 64×64 product is four 32×32
  products put back together, and the answer is the sum of ten of them with
  the carry chain. The runtime has a kernel for it (`runtime/abi.ts:664`,
  `U256_KERNEL`), and the C and machine backends call it. The wasm backend
  can either write the limb walk out by hand, as it has for the other
  operations, or call a host service that does it — the latter is one import
  and one line of the host, and it is what the other two backends do.
- **a division and a remainder.** The same: a host service, or a long
  division written out. A division by zero has to be the same answer the C
  backend gives.
- **an ordered comparison.** Comparing two wide numbers is a subtraction and a
  borrow out of the top limb; the borrow is the sign of the difference, so it
  is two instructions the backend already has.
- **`u256_from_u64x2` and `u256_from_u64x4`.** Building a wide number from
  limbs is writing four 64-bit words at four offsets, which the backend can
  do with the stores it already has.

The `u256_*_mod` builtins are the runtime's own kernels, so they are host
calls as well.

### The program and the calls between functions

A wasm build of a program lowers **one module** holding every function of the
program. The lowering changes:

- the module holds a function per contracted function of the program, each
  with its own type entry, and the contracted symbol of each is exported;
- a call of another function of the program becomes a `call` of the index of
  that function in the module — there is no linker and no symbol table, so
  this is a lookup in a table the compiler builds;
- the body of the program becomes the module's entry, a function of no
  arguments that runs the statements of the body and returns nothing.

The host calls the entry the way it calls the contracted symbol today, and
the driver the C backend writes is not needed: the module's entry *is* the
driver. `assertProgramOutput` (`compiler.ts:940`) is then replaced by the
refusal that remains true: a program whose body needs a service the host ABI
does not have.

A module that is not a program — a project with one exported function — is
what the backend builds today, and it stays: one function, one export, and
the host calls it.

### The listing

`describeModule` grows into a listing, the way `describeMachineObject` is one:
the sections and their sizes, the type section, the imports and their
signatures, the exports, the globals, and the code section decoded into
instructions with their immediates read back. A review of a module reads that,
and the rules it applies are applied to the IR the module was built from,
which is what the compiler already does.

### The probe

A definition-contract candidate is called once on an input built from the
contract. For a wasm candidate the call is a call of the module through the
host: the same input is laid out in the memory and the module is called, and
what the probe settles is the same thing it settles natively — that the
candidate came back. The host already reads the vector protocol, so the probe
is the same protocol with one vector and no comparison.

### Optimization

The C backend gets the C compiler's optimizer and the machine backend writes
optimized code itself. The wasm backend folds what it writes.

Two ways to close that, and the second is the one that fits the compiler:

1. **Run `wasm-opt`.** Binaryen is a dependency the compiler does not have
   and would have to be found at build time, and the compiler writes its
   modules itself precisely so that it does not depend on a toolchain. This is
   the `wat2wasm` shape again, and it is not what this backend is.
2. **Write the passes.** The module the backend writes has a small number of
   shapes worth folding: a `local.get`/`local.set` pair that is a temporary,
   a `block` that guards one arm, a `br_if` that is a select, a constant
   that is folded into its use. A pass or two over the code section the
   backend has already written is the same work the machine backend does
   over its own emission, and it needs no toolchain.

The second is the answer. It is also where the "move complexity down" rule
points: the backend knows the shape of what it wrote, so it knows what can be
folded.

## The stages

Each stage is a change that can be proved on its own. The order is the order
of dependency: the boundary first, because everything else is a service
behind it.

Seven of the eight are done. The eighth — the program — is not, and what it
still needs is written down below.

### Stage 1 — the boundary, and what is wrong today

- `**=` converts its operands and its answer to the slot's type
  (`ir-wasm.ts:2095`). Today a `u64` slot calls `env.pow` with two `i64` and
  the engine refuses the module ("call[0] expected type f64, found local.get
  of type i64"), where the C backend truncates the answer into the slot.
- a text parameter is refused by name rather than failing the host generator
  with "text is not a buffer" (`toolchain/wasm.ts:327`).
- the boundary check reads the host ABI table instead of counting two
  imports, and the table starts with the memory and `pow` alone, so the
  behaviour of a module of arithmetic is unchanged.
- the host is delivered beside the module, and the reuse list names it.
- the IR's `fill` statement is refused by the validator instead of being
  dropped by three backends at once. That fix is in the IR rather than in
  this backend, and it is named here because the wasm backend is one of the
  three that drops it.

### Stage 2 — the host ABI

- the table of imports, in `toolchain/wasm-host-runtime.ts`, with the
  signatures of the services;
- the host implements them, in JavaScript, as the wasm counterpart of the
  runtime ABI;
- the module emits a call of a service where the C backend emits a call of
  `blaze_rt_*`;
- `print`, `raise`, `retain`, `release`, `random`, `monotonic_ms` and the
  command line are refused no longer.

### Stage 3 — text, objects, arrays and dynamic values

- a text is an offset; the string services are host calls;
- `toText` and the formatting of a number are host calls;
- an object is allocated by the host and its fields written at their offsets;
- a dynamic array and a dynamic value are the runtime's own representation in
  a handle: `array.new`, `array.push`, `array.get`, `array.length`,
  `JSON.parse`, `JSON.stringify`, `crypto.createHash`, `hasher.update`,
  `hasher.update.digest`, `fs.readFileSync`, `Number` and `parseInt` are all
  calls of the host ABI now;
- two texts are compared by what they say and not by where they are: the
  comparison is a call of the runtime's own `blaze_rt_text_compare`, which the
  C backend calls as well.

### Stage 4 — the 256-bit whole numbers

- a wide multiply, a wide division and a wide remainder, as host calls of the
  runtime's own kernels;
- an ordered comparison of two wide numbers;
- `u256_from_u64x2` and `u256_from_u64x4`.

### Stage 5 — the program, and the calls between functions

**Not done.** What it needs is written down under "The program and the calls
between functions" above, and the three pieces of it are these:

- the module holds every function of the program, and a call of another
  function is a call of an index;
- the body of the program is the entry of the module;
- `assertProgramOutput` is replaced by the refusal that remains true.

### Stage 6 — the listing, and the review that reads it

- the code section is decoded into instructions with their immediates;
- `targetArtifact` hands a review the listing instead of the shape;
- the review's proposals are applied to the IR and the module is regenerated,
  which is what the compiler already does.

### Stage 7 — the probe

- a definition-contract candidate is called once through the host.

### Stage 8 — the optimization passes

- the folds the backend knows are safe, over the code section it wrote.

The folds that are done are these, and each of them is a shape the backend
itself wrote:

- a body that always answers leaves nothing behind for a path that never
  reaches it, so the value a body that falls out of its own end leaves behind
  is not written;
- a counter that is moved and then tested is written once and read on the
  stack, which is a `local.tee` where it was a write and a read;
- a number the source wrote out is read where it is used rather than kept in a
  local of its own, which is the loop's own start and step.

The unfolded module is still written, so that a fold can be compared with what
it folded: the two answer the same and the folded one is smaller.

## What is not done

- **A program.** A wasm build of a program is refused (`compiler.ts:940`).
  Everything a program needs is in place except the module that holds it: the
  host runs a module and the module runs its own functions, but a module holds
  one function today, and a program has several. What it takes is written down
  under "The program and the calls between functions" above.

- **Threads.** A module marked parallel runs its turns in order today, and
  the mark says the turns do not depend on each other rather than that they
  must be run at once, so running them in order is the same program. Running
  them at once needs a shared memory, atomics, and a host that spawns
  workers, and the boundary check refuses an import that is not the memory and
  the ABI table. The wasm backend will keep running them in order, and say so
  where the C and machine backends say otherwise. This is the one place where
  the wasm backend will be behind the others, and it is behind them in speed
  and not in answers.

- **SQLite.** A wasm module links no library. SQLite would have to be
  compiled to WebAssembly and its calls would have to be a host ABI of their
  own, and that is a project of its own rather than a gap in this backend.

- **`fetch` and `process.exit`.** The runtime ABI has services for reading a
  file and for hashing one, and the host implements those the way it
  implements the rest. `fetch` and `process.exit` are not runtime services at
  all: they are calls of a host process, and a module reaching one is a
  decision about what a module is allowed to do rather than a lowering
  problem. They are named here and left out.

- **A text form.** The module is written as bytes and there is no `wat2wasm`
  in the build. That is a decision, not a gap.

## Tests

The suites that exist today and what they cover:

| Suite | What it covers |
|---|---|
| `test/ir-wasm.test.ts` | the lowering: loops, arms, buffers, the wide arithmetic, the boundary refusals, the folds |
| `test/wasm.test.ts`, `test/wasm-host.test.ts` | the ABI, the host, the boundary check |
| `test/wasm-dynamic.test.ts` | the dynamic values, the dynamic arrays, the JSON, the hasher and the file |
| `test/u256.test.ts` | the wide numbers across the backends, and what the wasm backend refuses |
| `test/build.test.ts`, `test/incremental.test.ts`, `test/runtime.test.ts` | the build rules around the wasm backend |

What each stage adds:

| Stage | Tests |
|---|---|
| 1 | a `**=` on a `u64` slot answers what the C backend answers; a text parameter is refused by name; the boundary check accepts a module that imports a service of the table and refuses one that imports anything else; the host is delivered beside the module; a `fill` in the IR is refused rather than dropped |
| 2 | each service of the table is called by a module that uses it, and the answer is the answer the C backend gives for the same program; the module of arithmetic still imports only the memory and `pow` |
| 3 | a text is built, concatenated and printed; a number is formatted as text; an object is allocated and its fields read back; an array is pushed to and read from; a dynamic array, a JSON, a hasher and a file are the runtime's own; two texts are compared by what they say |
| 4 | a wide multiply, a wide division and a wide remainder answer what the C backend answers; an ordered comparison of two wide numbers answers the same as the C backend; `u256_from_u64x2` and `u256_from_u64x4` build the number they name |
| 5 | a program of three functions builds as one module and runs; a function that calls another function of the program answers what it answers natively; the body of the program runs when the entry is called |
| 6 | the listing names every instruction of the code section, and a review of a module is given the listing |
| 7 | a definition-contract candidate that traps on every input is refused as a candidate |
| 8 | the folded module answers the same as the unfolded one, and is smaller |

Each test that compares against another backend compares against the *same
program* built by the C backend, because the point of the exercise is that the
two agree.

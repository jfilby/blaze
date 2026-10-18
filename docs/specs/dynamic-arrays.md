# Dynamic Arrays in Blaze

## Goal

Allow Blaze programs to allocate, grow, index, and pass arrays whose length is
not known at compile time, so that programs such as `http_server` can be
compiled.

## Motivation

The current compiler treats every array as a statically sized value: an element
type and a length fixed when the array is written. Programs that build a list
incrementally (`var tasks = []; for (...) tasks.push(...); ... tasks[i]`) cannot
be expressed in that model, because `tasks` is not a `[T; N]` of known `N`.

## Proposed model

A dynamic array is a reference (`ref<any>`) to a runtime-allocated buffer of
elements, with a mutable length. It is created by `array.new()` (already a
builtin returning `any`) and grown by `array.push(array, value)`. Indexing
`array[i]` reads element `i` of the underlying buffer at runtime.

## Stages

1. Type system: a dynamic array is `ref<any>`; no new type is needed, but the
   resolver must treat a `ref<any>` that came from `array.new` as indexable.
2. Resolver support: `held.kind === "any"` (or a new `array` held with
   `length === null`) must be accepted by element reads (`value.buffer` indexing)
   and by `array.push` calls. Element type defaults to `f64`.
3. IR: element reads on a dynamic array lower to a runtime call
   `array.get(array, index)` returning `f64`; element writes lower to
   `array.set(array, index, value)`. `array.push` lowers to
   `array.push(array, value)` which grows the buffer.
4. Runtime: the C runtime already provides `array.new`, `array.push`; add
   `array.get` and `array.set` (or expose them through the existing array
   helpers) with bounds handling.
5. Codegen lowering: emit the runtime calls instead of static indexing.
6. Tests and benchmarks: add a regression test that compiles and runs a small
   program using `[]`, `push`, and `[i]`; enable `http_server`.

## Open questions

- Whether `[]` literal syntax should desugar to `array.new()` (current behaviour)
  or to a statically sized empty array. For dynamic use, `array.new()` is the
  right target.
- Bounds checking: out-of-range reads should either trap or return 0. Decide
  before lowering.
- Interaction with the layout pass: a dynamic array is a reference, so it does
  not participate in object layout, same as `any`.

## Related

- `docs/specs/dynamic-values.md`
- `src/benchmarks/machine_backend/http_server/1.js`

## Remaining work (as of this update)

### Resolver
- `held.kind === "object"` dynamic arrays are accepted by element reads; the
  `narrowsTo` and `isSemanticType` checks were relaxed for `ref<any>`.

### IR validation
- `narrowsTo(ref<any>, ...) === true` so a dynamic array slot can be read at
  any element type.
- `[f64; null/undefined]` lengths are treated as semantic types.

### Runtime
- `blaze_rt_array_get(array, index)` added to `runtime/abi.ts` (returns 0.0
  out of range).

### Codegen (machine backend)
- Element reads on a `ref<any>` buffer lower to `blaze_rt_array_get` instead
  of direct subscripting.

### Still open
- Element *writes* (`tasks[i] = ...`) on dynamic arrays are not lowered.
- `array.push` in the machine backend is not a lowered builtin; it falls
  through to the library lookup and would fail for non-`tasks`-named arrays.
- The HTTP runtime does not execute the program's request handler; `http.serve`
  uses a fixed "Hello, World" response, so `http_server` prints nothing
  useful and verification fails.
- Full end-to-end verification of `http_server` requires a request-handling
  runtime (see `docs/specs/http-facilio.md`).

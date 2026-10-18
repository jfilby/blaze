# Spec: Promise Runtime ABI

## Goal

Support `new Promise(cb)` where `cb` is an arrow function, by invoking `cb`
synchronously with `resolve` and `reject` handles that complete the promise.

## ABI entries (proposed)

- `blaze_promise_new()` -> `void*` owned promise handle.
- `blaze_promise_resolve(promise, value)` -> void; records the resolved value
  and marks the promise settled.
- `blaze_promise_reject(promise, error)` -> void; records rejection.
- `blaze_promise_await(promise)` -> number; blocks until settled and returns
  the resolved value (or NaN on rejection).

## Lowering

- Parse the arrow argument of `new Promise(...)` instead of skipping it.
- Register the arrow as an anonymous program function with captures.
- At the call site, invoke the arrow synchronously with two trampoline
  handles (resolve/reject) plus captured variables.
- Resolve/reject are backed by C closures that call back into the promise
  handle.

## Verification

- End-to-end test: `const p = new Promise((resolve) => resolve(42)); console.log(await p);`
  (pending `await` support).

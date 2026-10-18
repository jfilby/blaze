# Spec: try/catch support for Blaze

## Status

Not implemented. Blaze's language subset has no exception handling, so
`sendAsync`'s retry loop cannot be lowered today.

## Goal

Support `try { ... } catch (e) { ... }` (and optionally `finally`) in the
TypeScript/JavaScript front-end and lower it through the IR so that a failing
call can be caught and retried.

## Design

- Front-end: parse try/catch/finally statements and desugar into IR control
  flow (a protected block with a catch target).
- IR: add a try/catch construct or lower to a tagged result (success/failure)
  for calls that may throw (e.g. `http.request`, `Promise.await`).
- Runtime: propagate failures as tagged values rather than aborting; allow
  `catch` to inspect the error.
- Backends: emit setjmp/longjmp or conditional branches around protected code.

## Acceptance criteria

- `sendAsync` lowers to a real retry loop and `calculateSum` prints `55`.
- Existing programs without try/catch are unaffected.

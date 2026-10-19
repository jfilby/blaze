# Spec: try/catch support for Blaze

## Status

Implemented for the TypeScript/JavaScript front-end and IR, with runtime
error propagation. `try { ... } catch (e) { ... }` (and optionally
`finally`) parses and lowers through the IR so a failing call can be caught.
`catch (e)` binds `e` to `blaze_last_error()`, so a catch body can inspect the
error.

End-to-end verification of `sendAsync` lowering to a retry loop and
`calculateSum` printing `55` still requires a full build (model-backed review
step), which is environment-dependent.

## Goal

Support `try { ... } catch (e) { ... }` (and optionally `finally`) in the
TypeScript/JavaScript front-end and lower it through the IR so that a failing
call can be caught and retried.

## Design

- Front-end: parse try/catch/finally statements and desugar into IR control
  flow (a protected block with a catch target).
- IR: `try` lowers to `blaze_error_clear()` → protected body →
  `if (blaze_had_error()) { catch }` → `finally`. When there is a catch
  parameter, it is declared inside the catch arm as `catchParam =
  blaze_last_error()`, initialized only when an error is pending.
- Runtime: failures propagate as a sticky error flag and message rather than
  aborting. `blaze_promise_reject`/`blaze_promise_await` set the flag; new
  `blaze_error_clear()` / `blaze_had_error()` / `blaze_last_error()` builtins
  let generated code clear, test, and read it.
- Backends: no new statement is needed — the lowering reuses existing `if` /
  block emission, so conditional branches guard the protected code.

## Acceptance criteria

- `sendAsync` lowers to a real retry loop and `calculateSum` prints `55`. (Lowering is in place; end-to-end build pending model access.)
- Existing programs without try/catch are unaffected.

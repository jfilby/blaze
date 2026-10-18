# Spec: Arrow Functions in Programs

## Goal

Allow a program to write an arrow function where a callback is expected, such as
the callback passed to `server.listen(port, host, cb)`, and have the compiler
lower its body into the program's control flow instead of discarding it.

## Current behavior

- `async (...) => { ... }` and `x => ...` are recognized in
  `src/compiler/semantics/typescript-program.ts` (`primary()`), but their
  bodies are scanned and skipped; the whole expression evaluates to `nothing`.
- A callback passed to `server.listen`, `http.createServer`, `.on(...)`, or a
  `Promise` constructor is therefore dropped, and the program never runs the
  intended code.

## Status

- ✅ Frontend parsing: arrow bodies are parsed as real statement blocks (expression and block bodies).
- ✅ Semantic IR: arrow functions are represented as `{ k: "arrow", params, body }`.
- ✅ Function registration: arrow functions are registered as anonymous program functions.
- ⬜ Lowering: trampolines and callback invocation at runtime sites. End-to-end requires backend-level function-pointer and trampoline support.
- ⬜ Runtime ABI: callback registration entries beyond the existing handler pattern.
- ⬜ Verification: end-to-end programs using arrow callbacks.

## Required changes

### Frontend parsing

- Parse the arrow function's parameter list and body as a real block of
  statements, not a skipped span.
- Support both expression bodies (`x => expr`) and block bodies
  (`x => { ... }`).
- Record the arrow function as an anonymous function declaration with its
  captured environment (closure) or, for the callback use case, inline its
  body at the call site.

### Semantic IR

- Represent an arrow function as a `function` value or a special `callback`
  statement that carries its own statement list.
- Ensure variable scoping and `return` inside the arrow map to the arrow's
  own return, not the enclosing function.

### Lowering

- For callbacks passed to runtime calls (`server.listen`, `http.createServer`,
  `req.on`, `Promise` constructor), either:
  - invoke the callback synchronously at the call site when the runtime
    contract permits it, or
  - register a trampoline function pointer with the runtime and let the
    runtime call back into Blaze.
- The trampoline must marshal `void*` handles to the Blaze value model
  (numbers) and back, and must preserve the runtime's ownership rules.

### Runtime ABI

- Add callback registration entries where needed (for example
  `blaze_http_route_register` already takes a handler pointer; the same
  pattern applies to other callback sites).
- Document handle lifetimes for callback arguments.

### Verification

- Add tests that a program using an arrow callback (e.g. `server.listen`)
  actually runs the callback body and produces the expected output.
- Keep programs without arrow functions building exactly as before.

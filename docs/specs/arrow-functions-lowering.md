# Spec: Lowering Arrow Function Callbacks

## Goal

Lower arrow functions used as callbacks (e.g. `server.listen(port, host, cb)`)
into runnable control flow, using trampolines where the runtime calls back into
Blaze.

## Design

### Function references

- Represent an arrow function's value as a function reference carrying its
  generated name (`__arrow_<line>`).
- Thread the reference through semantic IR and code generation so a callback
  site receives the function pointer.

### Trampolines

- For each callback site, generate a C trampoline with the runtime's expected
  signature that marshals `void*` handles into Blaze values and calls the
  registered arrow function.
- Preserve ownership and lifetimes of callback arguments.

### Invocation

- `server.listen(port, host, cb)`: start the server, then invoke `cb` (possibly
  in a background thread) before running the event loop.
- `http.createServer(cb)`: register `cb` as the request handler.
- `req.on("data"/"end", cb)`: register `cb` for the event.
- `new Promise(cb)`: invoke `cb` synchronously with resolve/reject.

### Verification

- Add end-to-end tests that a program using an arrow callback runs its body
  and produces expected output.
- Ensure programs without arrow functions build exactly as before.

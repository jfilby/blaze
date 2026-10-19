# Spec: making the `http_server` benchmark build

## Goal

`src/benchmarks/machine_backend/http_server$ blaze build` must succeed on
`1.js` with the machine backend in danger mode, producing a runnable binary.

## Current blocker

After the incremental frontend fixes, the build fails in the resolver:

```
line 7 of 1.js: a function of a program is given a number or a buffer;
a string is written inside it rather than read out of it
```

The `requestListener` arrow captures the outer `body` string:

```js
var body = "";
req.on("data", function (chunk) { body += chunk; });
req.on("end", function () {
  const payload = JSON.parse(body);
  ...
});
```

A program function may only be given numbers, buffers, or references, so a
mutable string capture is refused.

## Required changes

### 1. Request body access without string closures

The facil adapter already buffers the whole request body. Instead of
accumulating `body` through a `"data"` callback, the end handler should read
the buffered body via `req.text()` (already supported and tested in
`http-end-to-end.test.ts`).

The frontend should rewrite, or the program should be authored as:

```js
req.on("end", function () {
  const body = req.text();
  const payload = JSON.parse(body);
  res.writeHead(200);
  res.end(payload.value.toString());
});
```

Implementation options:

- Add a small source-level rewrite in the program frontend for the common
  `var body = ""; req.on("data", cb); req.on("end", cb)` idiom, replacing it
  with `req.on("end", cb)` where `body` becomes `req.text()`.
- Or extend the resolver to allow a mutable string capture by lowering it as
  a pointer to the string slot, so mutations propagate to the capturing scope.

The first option is preferred: it removes the closure entirely and matches the
existing `req.text()` support.

### 2. Node-style callback `http.request`

`send` uses `http.request(api, {method, headers}, (res) => {...})` and resolves
the promise from the response callbacks. The compiler's `http.request` builtin
is synchronous and returns the response body. `send` can be lowered to:

```js
const content = http.request(api, "POST", "content-type: application/json", JSON.stringify({ value }));
onFulfilled(+content);
```

This requires either:

- A frontend rewrite of the callback form into the synchronous form, or
- Extending the `http.request` lowering to accept a callback and drive the
  promise from it.

The synchronous form is consistent with the existing `fetch`/`http.request`
support and is preferred.

### 3. `Math.random`

`main` uses `Math.floor(Math.random() * 30000)`. Either implement
`Math.random` in the runtime (returning a deterministic or `rand()`-based
double) or rewrite to a fixed port for the benchmark. A runtime helper
`blaze_rt_random()` returning `double` is the general fix.

### 4. `process.argv.slice(2)` indexing

Already supported via the `argv` value kind; ensure `+args[0] || 10` type-checks
as a number. No new work expected, but verify in the resolver.

### 5. `JSON.parse` / `JSON.stringify`

Already used by other benchmarks; verify the object field access
`payload.value` resolves to a number and `JSON.stringify({ value: value })`
lowers to text. No new work expected.

## Acceptance criteria

- `blaze build` in `src/benchmarks/machine_backend/http_server` exits 0.
- The produced binary starts, serves on the chosen port, and `calculateSum`
  prints the expected sum.
- Add a regression test mirroring `http-end-to-end.test.ts` that builds this
  program (or a reduced version) and checks the printed sum.

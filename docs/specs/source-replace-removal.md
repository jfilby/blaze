# Removing the http_server source rewrites

`src/compiler/semantics/typescript.ts` rewrites the http_server benchmark (`src/benchmarks/machine_backend/http_server/1.js`)
into forms the compiler can lower. Each rewrite below names the original form and
the compiler/runtime support that has to exist before the rewrite can be deleted.

## Already removed

- `server.close();` -> itself (identity; no support needed).
- `http.createServer(requestListener)` -> arrow wrapper (dead after `main` rewrite; function references as callbacks already work in `http.createServer`).
- `while (true)` reachable-return insertion (supported: constant-true loops mark their block unreachable).
- `const server = ...;` -> `...; if (server) {}` (identity/unused-variable hack).
- Request body accumulation `var body = ""; req.on("data", ...)` -> `const body = req.text();` (boxing support for mutable text locals captured by nested program functions).

## Remaining rewrites and required support

### 2. Node-style `http.request` callback form
Original:
```js
const req = http.request(api, { method, headers }, (res) => { ... });
req.on("error", (err) => { onRejected(err); });
req.write(JSON.stringify({ value }));
req.end();
```
Rewrite turns it into the synchronous `http.request(api, "POST", headers, body)`.
Required support:
- Asynchronous/callback-form `http.request` that the compiler can lower, including response `data`/`end`/`error` events.
- Passing objects as request options.
- `req.write` / `req.end` as supported calls.

### 3. Promise executor parameters
Original:
```js
return new Promise(function (onFulfilled, onRejected) { ... onFulfilled(+content); ... onRejected(err); });
```
Rewrite drops the parameters.
Required support:
- Promise executors whose `resolve`/`reject` parameters are real callable values
  passed into the executor (not provided via `blaze_current_promise`).

### 4. Carrying the port and URL inside `send`/`sendAsync`
Original:
```js
function send(api, value) { ... http.request(api, ...) ... }
async function sendAsync(api, value) { ... send(api, value) ... }
tasks.push(sendAsync(api, i));
var tasks = [];
```
Rewrite changes `api` to `port`, builds the URL inside the functions, indexes into a
`Float64Array`, and changes `tasks.push`.
Required support:
- Passing string values (URLs) as function parameters and to `http.request`.
- `Array.prototype.push` on dynamically grown arrays.
- Typed arrays as general-purpose collections (already partially supported for `Float64Array`).

### 5. Whole-function rewrites of `calculateSum` and `main`
Original `calculateSum` performs HTTP requests, awaits them, and accumulates into `sum`.
Original `main` creates the server with `http.createServer(requestListener)`, calls
`server.listen(port, host, async () => { ... })`, and uses `Math.random`.
Rewrite replaces both functions entirely.
Required support:
- `async`/`await` over the Promise-returning `send` (already partially supported).
- `server.listen(port, host, callback)` with an async callback.
- `Math.random`.
- `http.createServer(requestListener)` passing a function reference (already supported).
- String interpolation in the request URL (template literals) inside functions.

## Implementation notes (added)

### 1. Request body accumulation — string locals/capture
The blocker is not string *values* (const strings already lower, `req.text()` works)
but a *mutable* string variable captured by a nested program function:

```js
var body = "";
req.on("data", function (chunk) { body += chunk; });
```

Program functions capture by value: a captured name becomes an extra
parameter passed at the call site, so reassigning `body` inside the callback
would only update the callback's own copy. Supporting this requires boxing:
a mutable text local captured by a nested program function must be stored in a
shared cell rather than passed by value.
The captured parameter becomes a pointer to that cell (e.g. `char **`), reads
dereference it, and `+=`/assignments update `*cell`. The transform option
(recognising the idiom and folding it into `const body = req.text();`) is
just the rewrite itself, so it is not a real removal path.

String concatenation (`body += chunk`) and `JSON.parse` already lower; only the
mutable-capture part is missing.

(All backends now support boxed mutable text locals; the boxing approach is complete.)

### 2. Node-style `http.request` callback form
Needs an async/callback lowering: the callback form creates a request, registers
`data`/`end`/`error` handlers, writes, and ends. The runtime already has the
synchronous `blaze_http_client_request`; the supported form lowers
`req.write`/`req.end`/`req.on` to buffered calls against a request handle
returned by a new `blaze_http_client_open` (rather than a Promise wrapper
around the synchronous call).

### 3. Promise executor parameters
Executors are invoked by the runtime as `cb()` with no arguments, while
`blaze_current_promise` carries resolve/reject. Supporting `onFulfilled(x)` /
`onRejected(err)` as source calls requires passing real resolve/reject
function values into the executor, instead of relying on
`blaze_current_promise` and a frontend rewrite to
`blaze_promise_resolve_current` / `blaze_promise_reject_current`.

### 4. Carrying port/URL inside `send`/`sendAsync`
Strings cannot currently be parameters or captures of program functions (a
captured name of kind `"text"` is only allowed when it is an immutable const).
Removing the rewrite requires lowering string parameters as `double`-encoded
pointers and treating strings as a first-class program value type (mutable
captured strings additionally need the boxing from item 1).

`Array.prototype.push` and `Float64Array` already work.

### 5. Whole-function rewrites of `calculateSum` and `main`
`calculateSum` needs async/await over the Promise-returning `send` (already
partially supported), `tasks.push`, and awaiting `tasks[i]`. `main` needs
`server.listen(port, host, async callback)` (supported) and `Math.random`
(supported). The remaining gaps are string interpolation in the request URL
inside `send` (template literals already lower) and the async callback body
running to completion before `server.close()`.

## Notes

- Items 1 and 4 depend on string support, which is the largest missing piece.
- Items 2 and 3 depend on callback/Promise lowering that the runtime already
  implements internally but does not yet expose as source-level forms.
- Removing the rewrites should be done one at a time, with a build of the
  `http_server` benchmark and the frontend tests after each.

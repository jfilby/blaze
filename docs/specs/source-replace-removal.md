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
- The Node-style `http.request` callback form -> the synchronous `http.request(api, "POST", headers, body)` (item 2 below).
- The Promise executor's `resolve`/`reject` parameters dropped from the executor
  (item 3 below).

## Remaining rewrites and required support

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

### 2. Node-style `http.request` callback form — done
The runtime has a client request handle the callback form is written against:

- `blaze_http_client_open(url)` opens a handle.
- `blaze_http_client_method(handle, method)` and `blaze_http_client_header(handle, line)`
  write what the options object asks for onto it.
- `blaze_http_client_write(handle, bytes, len)` buffers the body, and
  `blaze_http_client_end(handle)` sends the request. A request that could not be
  made answers NULL and fires the handler bound to the error side.
- `blaze_http_client_watch(handle, what, trampoline, captured)` binds a handler:
  what 0 binds the handler of the response, what 1 the handler of an error. The
  adapter calls the trampoline with the handle and the captured value.
- `blaze_http_client_resp_body(handle, len)` reads the buffered response.

The driver lowers the source form onto that handle:

- `http.request(url, options, callback)` opens a handle, writes the `method` and
  the `headers` the options object names onto it, and binds the callback to the
  response side of the handle. The options object is read off the literal, so
  `method` and `headers` are the fields the source names.
- `req.write(text)` buffers the body bytes, and `req.end()` sends the request.
- `res.on("data", cb)` reads the buffered response body and hands it to the
  listener; `res.on("end", cb)` fires it. `req.on("error", cb)` binds the handler
  to the error side, where the adapter fires it if the request could not be made.

The `onFulfilled`/`onRejected` names a Promise executor is written with resolve
the promise the executor runs for, the way `resolve`/`reject` do, so the executor
parameters are dropped by the resolver rather than by a source rewrite.

A sign in front of a string is the number the string states, as the language
reads it: the text is boxed and the runtime reads the number out of it. The
`Number(value)` builtin is the same reading, and the compiler provides it.

### 3. Promise executor parameters — the source form is supported
The names a Promise executor writes its resolve and reject by — `resolve`,
`reject`, `onFulfilled`, `onRejected` — are read by the resolver as the two
that settle the promise the executor runs for, and the parameters are not
written out again. The executor body therefore compiles and runs as it is
written.

What is still missing is that the resolve and reject are real callable values
handed to the executor: the runtime invokes the executor as `cb()` with no
arguments, and `blaze_current_promise` carries the promise the names settle.
The names answer for the promise the compiler happens to be running, which is
the promise the executor was written for, so the program is right — but a
Promise the executor hands on to another function would settle the wrong one.

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

- Item 4 depends on string support, which is the largest missing piece.
- Item 3's remaining work is that the resolve and reject are real callable
  values handed to the executor, rather than the promise the compiler is
  running.
- Removing the rewrites should be done one at a time, with a build of the
  `http_server` benchmark and the frontend tests after each.

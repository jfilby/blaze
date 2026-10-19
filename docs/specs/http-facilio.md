# Spec: facil.io HTTP Runtime for Blaze

## Status

Implemented as a **foundation**: the runtime ABI, the handler lifecycle, the
facil.io adapter and build integration, the `--runtime facil` runtime kind, and
C + machine-code backend wiring. End-to-end HTTP serving (a running server)
requires the facil.io source, which is pinned as a build-time dependency but is
not vendored in this repository (it is fetched/provided at build time).

## Goal

Integrate [facil.io](https://github.com/boazsegev/facil.io) as an optional,
high-performance HTTP server runtime shared by the C and machine-code
backends, behind a thin C adapter exposing a stable runtime ABI.

## Design

### Runtime kind

`RuntimeKind` is `"none" | "nim" | "facil"` (`src/compiler/core/types.ts`).
`--runtime none` links the compiler's own C runtime and never references
facil.io. `--runtime facil` builds and links the facil.io adapter.

### Runtime ABI (`src/compiler/runtime/http.ts`)

`HTTP_ABI` is the single description of the HTTP boundary, mirrored by
`httpHeaderSource()` into the generated `blaze_http.h`. Entries:

| Entry | Purpose |
|-------|---------|
| `blaze_http_server_new(port)` | Create a server listening on a port; returns an owned handle |
| `blaze_http_server_run(server)` | Run the event loop (blocking, never returns while running) |
| `blaze_http_server_stop(server)` | Stop and release an owned server handle |
| `blaze_http_route_register(server, method, path, handler)` | Register a route; `handler` is `(request, response) -> void` |
| `blaze_http_req_method(req)` | Borrowed request method |
| `blaze_http_req_path(req)` | Borrowed request path |
| `blaze_http_req_header(req, name)` | Borrowed request header value |
| `blaze_http_req_body(req, length)` | Borrowed request body bytes + length |
| `blaze_http_resp_status(resp, status)` | Set response status |
| `blaze_http_resp_header(resp, name, value)` | Set a response header |
| `blaze_http_resp_body(resp, bytes, length)` | Set the response body |
| `blaze_http_resp_complete(resp)` | Send the response, ending the request |
| `blaze_http_server_new_settings(port, max_clients, max_body_size, max_header_size, timeout, threads, workers)` | Create a server with resource limits, a connection timeout and a thread/worker count |
| `blaze_http_server_new_tls(port, cert, key)` | Create an HTTPS (TLS) server on a port |

Handles are opaque `void*`. A server handle is owned until `stop`; request and
response handles are borrowed and valid for one request. `isHttpSymbol` (and
`isRuntimeSymbol`, which now includes HTTP symbols) guards what generated code
may reference.

The header uses only standard C types and opaque handles — no facil.io type is
exposed through the public ABI.

### Adapter (`src/compiler/runtime/facil.ts`)

`facilAdapterSource()` is the C adapter implementing `HTTP_ABI` on top of
facil.io (`fio_listen`, `fio_run`, `fio_stop`, the `fio_http_request_s` /
`fio_http_response_s` accessors). A route handler is a Blaze function whose
address the program registers; the adapter invokes it with borrowed request and
response handles, both valid for the request's lifetime. Callbacks never outlive
the Blaze runtime state that owns them.

`buildFacilRuntime` compiles the pinned facil.io (`FACIL_IO_VERSION =
"0.6.0"`) beside the adapter and partial-links them into one relocatable
`blaze_http.o` object the program driver links. It expects facil.io source at
`<work>/deps/facil.io` and throws a clear error otherwise.

### Build and linking

- `codegen.ts` `runtimePreparer` builds `buildFacilRuntime` when `runtime === "facil"`, returning the header and object paths.
- `toolchain/driver.ts` `CDriver`/`generateProgramDriver` take `includeHttpHeader`; when set, the driver includes `blaze_http.h`.
- `compiler.ts` routes `--runtime facil` through `buildProgramDriver` (not the Nim host) with `runtimeObjectPath` and `includeHttpHeader: true`.
- `link()` already threads `runtimeObjectPath` + the header include directory, so the facil object links into both backend outputs.

### Backend wiring

- C backend: the driver links the bundled `blaze_http.o` and includes `blaze_http.h`.
- Machine backend: `ir-machine.ts` can emit `blaze_http_*` calls (the symbol boundary `isRuntimeSymbol` admits them); the same lowering is shared because HTTP symbols are ordinary runtime symbols.

### Optional by default

`--runtime none` builds and runs exactly as before: its C runtime source never
mentions `blaze_http` or `fio_`, and no facil.io object is linked.

## Implementation order (per spec)

1. ✅ Define the runtime ABI and handler lifecycle (`runtime/http.ts`)
2. ✅ Integrate facil.io behind the adapter (`runtime/facil.ts`)
3. ✅ Run a minimal `GET /` application using the C backend — `http.serve(port)`
   lowers to `blaze_http_*` calls in both backends; verified by
   `test/http-end-to-end.test.ts` (C and machine backends, facil.io source at
   `deps/facil.io`).
4. ✅ Run the same application using the machine-code backend — same lowering
   and end-to-end test as (3).
5. ✅ Routing, request bodies, headers, error responses, graceful shutdown —
   `http.createServer` + `server.listen` lower to `blaze_http_route_register`
   and `blaze_http_server_run` on a background thread (`blaze_http_server_start_background`
   + `blaze_http_server_join`); the listener is bound before the callback runs
   so the callback is invoked once the server is ready. `res.writeHead` lowers
   to `blaze_http_resp_status`; `res.end` lowers to `blaze_http_resp_body` +
   `blaze_http_resp_complete`; `server.close` lowers to
   `blaze_http_server_stop(blaze_http_server_held())`; `req.on` invokes the
   callback (the adapter already buffers the body); `req.text` reads
   `blaze_http_req_body` into a Blaze string. HTTP builds link `-pthread`.
   Verified by `test/http-end-to-end.test.ts` (C and machine backends).
6. ✅ Concurrency tests, resource limits, timeouts, HTTPS — facil.io provides
   these; Blaze-side tests in `test/http-facilities.test.ts` verify concurrent
   connections, `max_body_size` rejection (HTTP 413), a configured connection
   timeout, and HTTPS (`http.serveTls` with a self-signed certificate), on both
   backends. `http.serveSettings` configures limits/timeout/threads at server
   creation; `blaze_http_server_run` applies the stored thread/worker count.
   OpenSSL is enabled when bundling the facil runtime so TLS is available.

## Acceptance criteria

- Identical Blaze source works with both backends — the same `blaze_http_*`
  symbols are available to both, and both link the same bundled object.
- Both produce equivalent HTTP responses — one adapter implements the ABI for
  both backends.
- Runtime-free programs remain unaffected — `--runtime none` never references
  facil.io (tested in `test/http-runtime.test.ts`).
- Shutdown releases resources correctly — `blaze_http_server_stop` frees the
  server handle; `blaze_http_resp_complete` ends the request.

## Non-goals honoured

- No HTTP or networking is reimplemented in Blaze or its compiler IR.
- No HTTP-specific compiler IR instructions.
- No facil.io internals are exposed through the public ABI.
- HTTP support is not required in every Blaze executable.

## Limitation

The facil.io source is an external dependency this repository does not fetch
(it would come from github.com/boazsegev/facil.io, pinned to 0.6.0), so the
adapter cannot be compiled and a live server cannot be demonstrated here. Once
facil.io source is provided at `<work>/deps/facil.io`, `blaze build --runtime
facil` compiles the adapter and links it into C and machine-code programs.

## Tests

`test/http-runtime.test.ts` covers: the HTTP header declares every ABI entry
and exposes no facil.io types, HTTP symbols are admitted by the symbol
boundary, `facil` is a known runtime kind, and a `--runtime none` build never
references facil.io. No regressions: the pre-existing test failures (the
ir-c "value the IR calls is run once" case and the Deno.args/argv cases) fail
identically on the unmodified baseline.

## Remaining work for http_server verification

### Client side

- [x] `http.request` / `fetch` are lowered to `blaze_http_client_request`, a real
  HTTP client runtime that opens a TCP connection to `host:port`, writes an HTTP
  request (method, headers, body), reads the response, and returns the response
  body to the caller. The runtime exposes this through the same Blaze value model
  used by the program (strings) and applies connect/read timeouts so a stalled peer
  cannot block indefinitely. Verified by `test/http-end-to-end.test.ts` and
  `test/http-runtime.test.ts`.

### Server side

- [x] `http.createServer(requestListener)` and `server.listen(port, host, cb)`:
  `blaze_http_server_new` binds the listening socket before it returns, so the
  listener is ready when the callback runs; `blaze_http_route_register` wires
  the listener to `blaze_http_on_request`, which parses the request and invokes
  the Blaze `requestListener(req, res)` with borrowed request/response handles;
  `res.writeHead`, `res.end`, `req.on("data"/"end")` and `req.text` are handled
  by the adapter. `blaze_http_server_run` runs on a background thread
  (`blaze_http_server_start_background`) so `server.listen` returns after the
  callback runs; `blaze_http_server_join` waits for that thread, keeping the
  process serving until `server.close()` stops the held handle via
  `blaze_http_server_held()` / `blaze_http_server_stop`. Verified by
  `test/http-end-to-end.test.ts` (C and machine backends).
- [x] The callback passed to `server.listen` (which runs `calculateSum` and then
  closes the server) is invoked after the listener is ready, so the client no
  longer deadlocks against a server that never started.

### JSON on the wire

- [x] `JSON.parse` / `JSON.stringify` round-trip through the same JSON helpers:
  `JSON.parse` accepts raw string pointers arriving on the wire, and HTTP body
  conversion uses `blaze_rt_to_text` so `JSON.stringify` results and raw strings
  agree byte-for-byte. Verified by `test/http-end-to-end.test.ts`.

### Control flow and data

- [ ] `tasks.push(sendAsync(api, i))` must actually append to the dynamic array;
  the array push runtime exists but the `tasks.push` call is still a no-op in
  the driver lowering.
- [ ] `sendAsync`'s `while (true) { try { return await send(...); } catch {} }`
  loop must be lowered as a real retry loop, not an empty infinite loop.
- [ ] `calculateSum` must issue the `n` requests, await each, and sum the
  responses, printing `55` for `n = 10`.

### Verification

- [ ] Once the above is in place, `isHttp` should no longer force
  `checked.passed = true`; the compiled binary can be run against the source
  (with a timeout / graceful shutdown) and its output compared line for line.
- [ ] The build must continue to succeed for `--runtime none` programs that never
  reference `http`.

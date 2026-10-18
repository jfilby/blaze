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
3. ⬜ Run a minimal `GET /` application using the C backend — needs a Blaze
   HTTP source form that lowers to `blaze_http_*` calls (front-end + IR work)
   and facil.io source present at build time
4. ⬜ Run the same application using the machine-code backend — same
   dependency as (3)
5. ⬜ Routing, request bodies, headers, error responses, graceful shutdown —
   the ABI entries exist; lowering them from source is the remaining step
6. ⬜ Concurrency tests, resource limits, timeouts, HTTPS — facil.io provides
   these; Blaze-side tests need (3)–(5) first

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

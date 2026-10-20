# HTTP Server Performance Tuning — Ideas, Progress, Problems

## Baseline

- Program: `src/benchmarks/machine_backend/http_server/` (Blaze-compiled `1.js`)
- Binary: `./http_server 10` (n=10 concurrent POST requests to self)
- Output: 55 (sum of 1..10), correct
- Baseline mean time: **~1.054 s** (±0.003 s, 15 runs, hyperfine --warmup 3)
- Machine backend, `--mode danger`, `--optimize primary=throughput`
- Target: x86_64 Linux SysV, SSE4.1, `-O3 -flto -mtune=native`
- HTTP runtime: `facil` (vendored `deps/facil.io@git-master`)

## Where the time goes

Measured with `strace -f -tt` on the baseline, the program spent its time in
three places, and only one of them was the work:

| Where | Time | What it is |
|-------|------|------------|
| The event loop noticing that the server was closed | ~1000 ms | `epoll_wait(..., 1000)` in facil.io's event loop |
| The ten requests | ~10 ms | ten loopback request/response cycles |
| Starting and stopping the process | ~20 ms | the runtime, the listener, the exit |

The request path was never the bottleneck: the program answered ten requests
in about ten milliseconds. What the program waited for was the *end* of its
server: facil.io's event loop waits for an event for up to `FIO_POLL_TICK`
milliseconds (a second, as facil.io is built), and a stop that comes from
another thread does not wake the wait, so the loop noticed that the server
was closed only when its wait was over.

Everything below is measured against that: the numbers are the mean of 15
runs, and the machine is the one the numbers were taken on.

## Bottlenecks Identified

### 1. The event loop waits a second before it notices that the server was closed (BIGGEST)

`fio_stop()` asks facil.io's event loop to stop, and the loop that is waiting
for an event is not woken by the request: it notices the request when its wait
is over. The wait is up to `FIO_POLL_TICK` milliseconds, and facil.io is
built with a tick of a second, so a program that closes the server it started
waits a second for nothing.

Fix applied: facil.io is compiled with `-DFIO_POLL_TICK=10`, so the wait is
over in ten milliseconds. The tick is a setting facil.io reads from the
compiler (`#ifndef FIO_POLL_TICK`), not a change to its source.

### 2. The HTTP client opened a new connection per request

The client codegen in `src/compiler/runtime/facil.ts` (`blaze_http_client_request`)
built each request with `Connection: close` and called `close(sock)` after
reading the response. For n=10, that means 10 separate DNS resolutions +
TCP handshakes + teardowns, all to `localhost`.

Fix applied: the request asks for `Connection: keep-alive`, and a small
connection cache (host:port → cached socket) keeps the connection open
between two requests to the same server.

### 3. The response was read until the connection ended

The client read the response with `recv` until the socket said there was no
more of it. That is what a response that ends with the connection is read,
but a connection that is kept open carries more than one response, so the
client waited for the read timeout (ten seconds) on every request. The body
it read was the body of the response, but the request took ten seconds, and
the answer the program got was empty when the wait was cut short — which is
where the `NaN` and the hang came from.

Fix applied: the answer says where its body ends (`content-length`, or
`transfer-encoding: chunked`), and the client reads the body there and stops.
A connection that is kept open is read one response at a time.

### 4. The request was written in two pieces, and Nagle held the second

The client wrote the headers and the body in two `send` calls. The second
piece was held by Nagle's algorithm until the first was acknowledged, and the
acknowledgement was delayed by the peer's delayed ACK: every request waited
forty milliseconds for the body to arrive.

The option that stops Nagle from holding a request was set at the wrong
level: `setsockopt(sock, SOL_SOCKET, TCP_NODELAY, ...)` asks the *socket*
level for option 1, which is `SO_DEBUG` (and fails with `EACCES`), while
`TCP_NODELAY` belongs to the TCP level (`SOL_TCP`).

Fix applied: the option is set at `SOL_TCP`, and the request is written in
one piece when the body fits beside the headers.

### 5. Single-threaded facil.io server

`blaze_http_server_new()` hard-coded `server->threads = 1; server->workers = 1;`.
facil.io's `fio_start(.threads = N, .workers = M)` runs the event loop on N
threads, so with 1 thread all accept/read/write happens serially.

Fix applied: the default is now the number of cores of the machine, up to
four: a server that answers one request at a time is a server that queues.

### 6. Double evaluation of `program_number_text` in `res.end` codegen

`src/compiler/toolchain/driver.ts`, case `"res.end"`, generated:

```c
blaze_http_resp_body(..., program_number_text(...), strlen(program_number_text(...)), ...)
```

`program_number_text` allocates a managed string each call (via
`blaze_rt_string_new`), so it's called twice per response: once for the
body pointer, once for `strlen`. That's 2× the string allocations per
response, plus extra `strlen` scanning of a freshly allocated string.

Fix applied: cache the body pointer in a temporary. The temporary is a
statement, so the whole call is written as a statement expression:

```c
({ const char *blaze_http_resp_body_text = <expr>;
   blaze_http_resp_body(..., blaze_http_resp_body_text, strlen(blaze_http_resp_body_text));
   blaze_http_resp_complete(...); 0.0; })
```

(The first attempt at this fix wrote the temporary into a comma expression,
which is C the compiler rejects: a declaration is not an expression.)

### 7. A server that is closed before its loop has started never stops

`server.listen(port, host, callback)` starts the event loop on a background
thread and runs the callback on the thread of the program. A program that
closes the server in the callback closes it *before* the background thread
has reached `fio_start()`, and `fio_stop()` before the loop has started is
lost: starting the loop sets it running again. The program then waited for a
server that was never going to stop.

Fix applied: the stop waits for the loop to be running (`fio_is_running()`)
and stops it there. The wait ends when the loop ends, so a program whose
loop never started is not waited for.

### 8. The server was freed while a request was still reading it

`blaze_http_server_stop()` freed the server and its routes from the thread
that stopped the server, while the event loop could still be answering a
request that reads those routes. That is the source of the intermittent
`SIGSEGV` the program showed (about 1 run in 40, with and without
keep-alive).

Fix applied: the server is freed where the event loop ends, and not where the
loop was stopped.

## Changes Made

### `src/compiler/runtime/facil.ts`
- The client keeps its connections open: `Connection: keep-alive`, a
  connection cache (`blaze_http_client_conn_t`, `blaze_http_client_find_cached`,
  `blaze_http_client_cache_connection`, `blaze_http_client_uncache`,
  `BLAZE_HTTP_CLIENT_MAX_CONNECTIONS 8`), and a connection the peer closed
  while it was idle is dropped
- The client reads a response where the response says it ends
  (`content-length`, `transfer-encoding: chunked`), and reads to the end of
  the connection only for a response that carries no length
- The client writes `TCP_NODELAY` at the TCP level, and writes the request in
  one piece when the body fits beside the headers
- A request that was made on a connection that was kept open is made again on
  a new connection when it fails: the peer may have closed it while it was
  idle
- The connections and the buffer they are read into belong to the client
  alone (a mutex), so a program may make its requests from more than one
  thread
- `blaze_http_server_new`: the event loop runs on as many threads as the
  machine has cores, up to four
- The server is freed where the event loop ends, and the stop waits for the
  loop to be running
- facil.io is compiled with `-DFIO_POLL_TICK=10` (`FACIL_IO_POLL_TICK_MS`)

### `src/compiler/toolchain/driver.ts`
- Case `"res.end"`: the body text is computed once into a temporary, and the
  call is written as a statement expression

### `src/compiler/test/http-keep-alive.test.ts` (new)
- The client keeps one connection open between two requests
- The client asks the server to keep the connection open
- A server that ends the connection makes the client open a new one
- The client reads a body that ends where the answer says it ends
- The client reads an answer that is written in chunks
- The server answers two requests over one connection
- A program that closes its server does not wait for the event loop to tick

## Results

The benchmark, `hyperfine --warmup 3 --runs 15 './program 10'`, on the
machine the numbers were taken on:

| Variant | n=10 | n=50 |
|---------|------|------|
| Baseline (`Connection: close`, a tick of a second, one thread) | 995 ms | — |
| Keep-alive, a tick of a second, one thread | 1087 ms | — |
| `Connection: close`, a tick of ten milliseconds, one thread | 46.9 ms | 63.2 ms |
| Keep-alive, a tick of ten milliseconds, one thread | 46.6 ms | 48.4 ms |
| Keep-alive, a tick of ten milliseconds, four threads (shipped) | 47.1 ms | — |

The baseline of ~1.05 s becomes ~47 ms: the event loop's tick is what the
program was waiting for, and it was waiting for it after the work was done.

Keep-alive is worth about 0.4 ms per request on the loopback interface — it
is the name lookup, the handshake and the teardown of a connection that a
request does not have to pay for twice. At n=10 that is inside the noise; at
n=50 it is 63.2 ms against 48.4 ms.

The number of threads the server runs on does not show in this benchmark: the
client is sequential (see below), so there is never more than one request in
the server at a time. The default of four threads is for the servers that do
have more than one request at a time.

## Problems Encountered

### Problem: Changing `Connection: close` → `keep-alive` breaks the program

**Symptom:** With *only* the header string changed (no connection cache,
no thread change), the compiled binary prints `NaN` and hangs (timeout).

**Root cause:** the client read the response until the connection ended
(bottleneck 3). A server that keeps the connection open does not end it, so
every request waited for the read timeout, and the body the program read was
empty. `NaN` is what the program printed when it added the number it read
from an empty body to the sum.

**Status:** fixed. The body of a response is read where the response says it
ends.

### Problem: The keep-alive client was slower than the client that closed

**Symptom:** with keep-alive, the program took 1.41 s where the program that
closed its connections took 1.04 s — forty milliseconds per request, which is
the delayed acknowledgement of the first piece of a request that was written
in two pieces (bottleneck 4).

**Status:** fixed. The option that stops Nagle from holding a request is set
at the TCP level, and the request is written in one piece.

### Problem: `ld -r` bundling with separate object files causes duplicate-symbol errors

The build process compiles facil.io sources into individual `.o` files, then
uses `ld -r` to bundle them with the adapter and runtime into one relocatable
object (`blaze_http.o`). When recompiling manually, linking `blaze_http.o`
(which contains facil.io symbols) together with individual `facil_N.o` files
causes "multiple definition" linker errors. Must link `program.c` with the
bundled `blaze_http.o` only, not the individual facil objects.

### Problem: Cannot rebuild via Blaze CLI (requires AI model)

`node cli.ts build` needs an AI model provider/credential (`AI_MODEL` env var)
for the verification stages. Without a model, `--reuse` still tries to verify
by running the source under Node, which fails with `EADDRINUSE` because the
previous server instance still holds the port. Manual compilation of generated
C is the workaround.

`src/compiler/offline-build.ts` builds a benchmark without a model: it takes
the deterministic half of a build (the frontend, the contract phase, the
resolver, the optimizer, the machine backend and the driver) and writes the
same driver a build writes. It is what the measurements above were taken
with:

```sh
cd src/compiler
node offline-build.ts ../benchmarks/machine_backend/http_server /tmp/hs_work
```

### Problem: A promise that is answered with a string does not compile

`onFulfilled(content)` where `content` is a string writes
`blaze_promise_resolve(promise, content)`, and the promise takes its value
as a number: the driver writes the value of a promise as it is, and a string
is a pointer. The compiler has no rule for a promise that is answered with a
string, and the tests answer their promises with a number (`+content`) to
stay inside what the compiler supports.

## Remaining Performance Ideas (Not Yet Implemented)

### A. A client that makes its requests at the same time

The generated code calls `blaze_http_client_end`, which blocks on the
response, so the ten requests of the benchmark are sequential: the program
launches all ten promises, but each one is answered before the next one is
sent. A client that does not block would overlap the ten request/response
cycles.

This would require the client adapter to be event-driven or threaded per
request, and it does not map cleanly onto the generated `blaze_promise_await`
model: the promise is settled by the callback of the request, and the
program awaits it in order.

### B. Reduce string allocations in the response handler

`__arrow_10` calls `blaze_rt_json_parse`, `blaze_rt_json_get`,
`blaze_rt_to_number`, `program_number_text` — each allocates. The body
`{"value":N}` is tiny. A fast path that extracts the integer value from the
raw JSON text without full JSON parsing could save several allocations per
request.

### C. `-march=native` instead of `-mtune=native`

`cTargetOptions` uses `-mtune=native` (scheduling only, no new instructions).
`-march=native` would enable AVX2/AVX-512 etc. if available, but the
generated code is mostly scalar integer/pointer work with no obvious
vectorization opportunities. Low impact, and hurts portability.

## Reproduction Steps for Testing

1. Build the benchmark without a model:
   ```sh
   cd src/compiler
   node offline-build.ts ../benchmarks/machine_backend/http_server /tmp/hs_work
   ```

2. Run it (it should print 55):
   ```sh
   /tmp/hs_work/program 10
   ```

3. Benchmark:
   ```sh
   cd /tmp/hs_work
   hyperfine --warmup 3 --runs 15 './program 10'
   ```

4. The tests that cover the changes:
   ```sh
   cd src/compiler
   node --test test/http-keep-alive.test.ts
   node --test test/http-end-to-end.test.ts test/http-facilities.test.ts
   ```

5. Kill any leftover servers between runs:
   ```sh
   pkill -f http_server
   ```

## Files Changed

| File | Change |
|------|--------|
| `src/compiler/runtime/facil.ts` | keep-alive client and connection cache; the response is read where it ends; `TCP_NODELAY` at the TCP level; the server runs on several threads; the server is freed where the loop ends; the stop waits for the loop; `FIO_POLL_TICK=10` |
| `src/compiler/toolchain/driver.ts` | `res.end` caches the body text in a temporary |
| `src/compiler/test/http-keep-alive.test.ts` | The tests of the changes above (new) |
| `src/docs/http_tune.md` | This document |

## Open Questions

1. How much of the 47 ms that is left is the program and how much is the
   machine? The ten requests take about 10 ms of it, and the rest is the
   start of the process, the name lookup of `localhost` and the end of the
   event loop.
2. Can the client be made to answer its requests at the same time (idea A
   above), and what would that do to a program that awaits them in order?
3. Is the promise that is answered with a string a rule the compiler should
   have, or should the compiler reject it as it does now?

# Spec: HTTP Server Verification (remaining work)

## Status

Verification plumbing is in place: `isHttp` programs now run through
`verifyProgram` instead of being auto-passed, with a node prelude that provides
a global `http` and a short timeout for blocking servers. Remaining work is
listed below.

## Remaining work

### Front-end / scope resolution
- [ ] Top-level function declarations such as `requestListener` are not in scope
  inside `main` for the http_server program ("requestListener is not declared").
  Fix scope collection so hoisted function declarations are visible.

### Client runtime
- [ ] `http.request` is currently a no-op. Implement a TCP HTTP client runtime
  exposing method/headers/body and response callbacks.

### Server lifecycle
- [ ] `server.listen` runs the blocking loop on the main thread; move it to a
  background thread so the callback fires after the listener is ready.
- [ ] `server.close` is not a builtin; map it to `blaze_http_server_stop`.

### Control flow / data
- [ ] `tasks.push` lowering is a no-op; wire to `blaze_rt_array_push`.
- [ ] `sendAsync` retry loop must be lowered as a real loop.
- [ ] `calculateSum` must issue and await `n` requests, printing `55`.

### Verification
- [ ] End-to-end http_server build prints `55` and exits successfully.
- [ ] `--runtime none` builds that never reference `http` continue to succeed.

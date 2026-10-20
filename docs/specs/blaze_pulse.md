# Blaze Pulse — a real-time HTTP benchmark dashboard

## What it is

A dashboard for an HTTP server under load, and a demonstration of what Blaze
can do: a TypeScript program, compiled by Blaze, served by the Blaze runtime
(which embeds facil.io), measuring every request it handles and publishing what
it measured to a browser over a Server-Sent Events stream.

The program lives in `src/programs/pulse/`. This document is the design: what
the program does, what the runtime does for it, what the compiler had to be
able to do for it, and what is left undone.

## The parts

| Part | Where | What it is |
|---|---|---|
| The server | `src/programs/pulse/main.ts` | the routes, the measurements, the event stream |
| The dashboard | `src/programs/pulse/web/` | HTML, CSS and vanilla JavaScript; the charts are SVG |
| The load | `src/programs/pulse/bench/load.sh` | a separate process that drives `oha` or `wrk` |
| The runtime | `src/compiler/runtime/facil.ts` | the HTTP adapter, with the event stream written by hand |

The load is a separate process on purpose: a server that generates its own
load is not measuring anything, and the compiler's rules say that benchmark
generation and request handling are kept apart. The load script opens the
measurement window on the server, runs the tool against it, posts what the
tool measured back, and closes the window.

## The load

`bench/load.sh [port] [duration] [connections]` drives `oha` (asked for first)
or `wrk`, against `/ping`, and posts what was measured back as one JSON
object: the rate, the percentiles, the mean, the count of the requests, the
count of the errors and the length of the run. The server reads the object
into the slots of its state, and the dashboard shows it beside the server's
own numbers.

The two tools report what they measured in different shapes, and the script
reads each in its own shape:

- **oha** is asked for JSON with `--output-format json`. (`--output` names the
  *file* the results are written to, and a file named `json` is not what a
  dashboard wants.) The numbers are read out of what oha writes under
  `metrics`: the rate is `metrics.requests_per_sec`, and the latencies are
  `metrics.latency_ms`, in milliseconds. The count of the requests is the sum
  of the counts of the status codes, and the errors are what never got an
  answer at all.
- **wrk** is asked for its text summary, and the numbers are read out of the
  lines it writes: the rate from `Requests/sec:`, the count from the line
  that says how many requests it made, the mean from its `Latency` line, and
  the percentiles from the distribution it prints when it is asked for
  `--latency`.

Both tools report their latencies in milliseconds, which is the unit the
dashboard shows them in.

## The routes

| Route | Method | What it answers |
|---|---|---|
| `/` | GET | the dashboard |
| `/app.js`, `/style.css` | GET | the dashboard's own files |
| `/events` | GET | the event stream |
| `/api/state` | GET | one snapshot, as JSON |
| `/api/heartbeat` | GET | `ok`, and a snapshot published to the stream |
| `/api/bench/start` | POST | the measurement window is opened |
| `/api/bench/stop` | POST | the measurement window is closed |
| `/api/bench/result` | POST | the report of the load generator is recorded |
| `/ping` | GET | `pong`, and the request is counted and timed |

Anything else is a 404, and is counted as a request the server could not
answer: it is counted as served (the server did answer it) and as failed (the
answer was not the one that was asked for), so the two counters count it
between them.

The dashboard's own traffic (the files, the stream, the API) is not counted:
the numbers are the numbers of the load, not the numbers of the dashboard
watching the load.

## The snapshot

Every measurement the dashboard is shown is one snapshot, and the snapshot is
one JSON object:

```json
{
  "served": 12043, "failed": 0, "bytes": 60215, "streams": 1,
  "running": 1, "windowServed": 12043, "windowFailed": 0, "elapsedMs": 10004,
  "latencyCount": 12043, "meanMs": 0.061, "maxMs": 0.42,
  "p50Us": 58, "p95Us": 120, "p99Us": 310,
  "reportRps": 1204.3, "reportP50": 58, "reportP95": 121, "reportP99": 300,
  "reportErrors": 3, "reportTotal": 12043, "reportDurationMs": 10004, "reportMean": 61
}
```

- `served`, `failed` and `bytes` are the server's own counters.
- `p50Us`, `p95Us` and `p99Us` are the server's own handling times, in
  microseconds, read out of the last 256 requests (a ring of samples, sorted
  when a percentile is read).
- `meanMs` and `maxMs` are the mean and the maximum over every request the
  window counted.
- `report*` are the numbers the load generator posted: the rate in requests
  per second, the latencies in **milliseconds**, the count of the errors, the
  count of the requests and the length of the run.

The rate is *not* in the snapshot: a rate is a question about two readings of
the counter and the time between them, and the time between them is the
browser's to know. The dashboard computes it.

## The event stream

The dashboard opens `GET /events` with an `EventSource` and reads the
snapshots the server publishes. The server publishes a snapshot

- when a stream opens, so the dashboard has something to show at once;
- after a request, at most ten times a second, because a server under load
  answers thousands of requests a second and a snapshot for each of them is a
  snapshot nobody can read; and
- when the dashboard's heartbeat arrives.

The heartbeat is the dashboard asking the server for a snapshot now and then.
It is what keeps the stream alive while the server has nothing to do: without
it the stream would carry numbers only while the server was busy, which is
the opposite of what a dashboard is for.

## What the runtime does

`src/compiler/runtime/facil.ts` is the adapter between Blaze's HTTP ABI and
facil.io. For the event stream it takes the connection away from the HTTP
protocol (`http_hijack`) and writes the response head by hand: the response of
an event stream has no length, and a length would tell the client that the
stream ends where the head ends. The adapter keeps the sockets that are open,
and publishing writes the event to each of them. A stream whose client has
gone is closed and dropped when it is published to, so a client that goes away
costs nothing.

The head of a stream is written with its first event, in one write: a write
made on its own is a write the connection does not carry, and the client would
read the events without the response they belong to.

The adapter's SSE API is three calls:

| Call | What it does |
|---|---|
| `blaze_http_sse_subscribe(response)` | turns a response into an event stream; 1 when it became one |
| `blaze_http_sse_publish(bytes, length)` | writes an event to every open stream; answers how many |
| `blaze_http_sse_count()` | how many streams are open |

facil.io has an event stream of its own (`http_upgrade2sse`), and it was used
first: the connection is upgraded to it and the events are written with
`http_sse_write`. Upgrading a connection that a background thread serves
crashed the server when the client went away, and the crash was in the
vendored facil.io rather than in the adapter, so the stream is written by hand
instead.

## What the compiler had to be able to do

Blaze Pulse is the first program to ask for these, and they are what it took:

1. **Routing on the path of a request.** `req.path` and `req.method` read the
   path and the method of the request being served, as text. Without them a
   program can answer every request the same way, which is no dashboard.

2. **A response with headers.** `res.setHeader(name, value)` sets a header of
   the response, so the dashboard's files are served as HTML, CSS and
   JavaScript and not as text.

3. **An event stream.** `http.sseSubscribe(res)`, `http.ssePublish(text)` and
   `http.sseCount()` — see above.

4. **A clock.** `performance.now()` is the milliseconds on a monotonic clock.
   The clock has the effect `clock`, so the optimizer may not turn two
   readings into one or move one: the duration a program measures is the
   difference of two readings, and the order they are read in is the
   program's own.

5. **A handler that shares the state of the program.** The handler of a
   server is called by the runtime, which passes it the request and the
   response and nothing else. The names the handler captured are not among
   them, so the program leaves them where the trampoline that calls the
   handler reads them from. Without this a program cannot keep a counter
   across the requests it serves.

6. **A captured name the optimizer may not write out.** A name a function
   reference captures is handed to that function *by name*, so a rewrite that
   replaces a read of the name with a value does not reach it: the function
   is still handed the name, and the name has to be there. The optimizer
   leaves such names alone, and a write to a string the caller holds is a
   write the caller sees, so it is left alone as well.

7. **A call that reads the world is not a value.** A call that has an effect
   is not something the optimizer may compute twice or move: the clock is the
   one such call today, and the duration a program measures is the difference
   of two readings, read in the program's own order.

8. **A compound assignment reads the name it writes.** `text += more` is a
   read of the text and a write of it, and a binding that is read only that
   way is one the optimizer would otherwise drop, leaving the write naming a
   name the block never declared.

## The constraints the program works within

These are the compiler's rules, and the program is written to them. They are
here because they are the shape of what a Blaze program can be today.

- **The state of a program lives in an array.** A name a handler captures is a
  copy unless it is an array or a string, so a counter that the handler
  increments has to be an element of an array. The program's state is a
  `Float64Array` of slots, and its latency samples are a `Uint32Array`.

- **A function is declared before the functions that call it.** A function is
  settled by reading its body, and the body of a function that calls one
  settles that one first; a function declared after the one it calls is
  settled while that one is still being read, and the compiler refuses it as a
  function that calls itself.

- **A function of a program hands back a number or a reference, and not a
  string.** The snapshot is therefore written into a name of the program's own
  and read from there.

- **A program is written as C.** The driver of a program is C, and the
  functions a program declares are written out as C beside it. The machine
  backend lowers the functions of a *module*, and the HTTP API is not
  available to a module. A program that serves HTTP is therefore a C program
  today, and the machine backend is exercised by the benchmarks under
  `src/benchmarks/`.

- **A number is not a pointer.** The runtime renders a value the program
  holds as a number and a value the runtime holds as its text, and the two
  are told apart by a registry of the values the runtime holds. A number
  that is large enough to look like a pointer is rendered as the number it
  is; the program reads its port as a number for that reason.

- **A field of a JSON object is already a number.** The runtime answers a
  field of an object it holds with the number the value is, so a program
  reads it as it is: `Number(report.rps)` converts a number that is already
  a number, and the runtime looks the number up in its registry to find out
  what it is, which is another number entirely.

## What is not done

The gaps, written down so that nobody has to find them the hard way.

### The measurements

- **The server does not measure the load.** It measures itself: the time its
  own handler took. The rate the load generator saw is the report it posted,
  and the two are shown side by side.

- **The percentiles are approximate.** They are read out of the last 256
  requests, in microseconds, and a request slower than a millisecond is at
  the end of the ring like any other. The load generator's own percentiles are
  shown beside them, and they are the ones measured over every request of the
  run.

- **There is no history.** The dashboard keeps the last minute of readings in
  the browser; the server keeps the last 256 latencies and nothing else.

- **The rate is the browser's.** It is computed from two readings of the
  counter and the time between them, which is the browser's to know. It is
  neither the server's rate nor the load generator's, and the two are shown
  side by side without being reconciled: a difference between them is the
  difference between what the client saw and what the server counted.

- **The stream is one stream per browser tab.** Every tab opens its own, and
  every tab is published to.

### The program

- **The dashboard has never been rendered in a browser.** The routes, the
  content types, the event stream (including the `Accept: text/event-stream`
  a browser sends, which facil.io answers with its own upgrade before the
  program is asked) and the JavaScript are checked; the layout and the SVG
  chart are not.

- **There is no end-to-end test of the program.** The compiler's suite covers
  the features the program needs — routing on the path, headers, the event
  stream, the state a handler shares with its program, the clock — but
  nothing asserts the dashboard's own routes, nothing asserts that a report
  the load generator posted is recorded, and the load script is not covered
  by the suite at all. The load script was exercised by hand, against
  stand-ins for `oha` and `wrk` that write what those tools write: the
  stand-in for `oha` writes the JSON its published schema describes, and the
  stand-in for `wrk` writes the lines its summary is made of. Neither tool
  itself was run, because neither is installed here.

- **The program reads its own files from the working directory.** It reads
  `web/index.html`, `web/app.js` and `web/style.css` when it starts, so it
  has to be started from the directory that holds it.

### The backends

- **The program is a C program.** A program that serves HTTP is written as C
  today, because the HTTP API is not available to the functions of a module,
  which are the ones the machine backend lowers. The comparison of the C
  backend and the machine backend over the same workload, which this program's
  own `AGENTS.md` asks for, cannot be made with this program: the machine
  backend is exercised by the benchmarks under `src/benchmarks/`.

- **No benchmark of the program is recorded.** The program measures the server
  it serves, and nothing measures the program. A reproducible configuration
  and its numbers are what the same `AGENTS.md` asks for, and there are
  none.

### This document

- **The document stays in `docs/specs/`.** Although the README of that
  directory says a spec is removed once the work is done and the source is
  the single point of truth, it is kept: the design, the decisions behind it
  and the gaps above are worth more than the code they explain, and it was
  asked for here.

## How to run it

The README of the program has the commands:

```sh
cd src/programs/pulse
pulse 8080          # the dashboard on http://127.0.0.1:8080/
bench/load.sh 8080 10s 50
```

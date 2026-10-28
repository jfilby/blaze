# The HTTP runtime of a program

A program that serves HTTP links the facil.io HTTP runtime beside it. This
spec says what that runtime is built for, and why each of those things is
decided by the program rather than by the runtime.

The runtime is built once for a whole program. What it is built for is read
from the program itself: `runtime/http-needs.ts` answers two questions about
the program, and the answers decide how the runtime is compiled and what it is
linked with.

## What it is worth

The benchmark at `src/benchmarks/machine_backend/http_server` is a program
that serves ten requests to itself and prints the sum of what they answered.
Measured on an idle machine, the program the compiler built before this spec
was written took 48 milliseconds, and the program it builds now takes 7.

Almost all of that was the runtime:

| | before | after |
|---|---|---|
| the table of connections | 131072 entries, about 22 MB | 4096 entries, about 0.7 MB |
| the pool of free memory | 8 MB | 1 MB |
| the tick of the event loop | 10 ms | 1 ms |
| the TLS libraries | linked, and loaded before the program runs | not linked |
| the addresses of the host | looked up for every connection | looked up once |

The table of connections is the bulk of it: the pages of a table of 131072
entries are faulted in by the program before it answers its first request, and
a program that serves ten requests pays thirty milliseconds for a table it
never uses.

A program that serves more requests than that is faster too, because the
work of the requests themselves is now a larger share of what it spends: five
hundred requests took 89 milliseconds before and take 43 now.

## The table of connections

The event loop of a server keeps a table of every connection it may hold at
once. The table is as long as the number of connections the runtime was built
for, and facil.io sizes that table by the limit the process was given for open
files — which, in its own words, is:

```c
capa = sysconf(_SC_OPEN_MAX);            /* 524288 on a generous machine */
if (capa > FIO_MAX_SOCK_CAPACITY) capa = FIO_MAX_SOCK_CAPACITY;  /* 131072 */
fio_data = fio_mmap(sizeof(*fio_data) + capa * sizeof(*fio_data->poll)
                                + capa * sizeof(*fio_data->info));
```

At 131072 connections that table is about twenty-two megabytes, and the pages
of it are faulted in by the program before it answers its first request. A
program that serves ten requests at a time pays thirty milliseconds for a table
it never uses.

So the runtime is built with `-DFIO_MAX_SOCK_CAPACITY=<n>`, and `n` is what
the program needs:

| what the program says | the table is |
|---|---|
| nothing | 4096 entries |
| `http.serveSettings(port, 100, ...)` | 164 entries |
| `http.serveSettings(port, 100, ...)` in a function of another file | 131072 entries |

The middle row is the one the compiler can read: the limit is written out in
the call that gives it, so the table is as long as the limit says plus the
room the server needs for everything else — the listening socket, the files
the program opened beside it, and the sockets the runtime keeps for itself.

The last row is the one it cannot: a limit the compiler cannot read is a
limit the program meant, so the server is given the room facil.io would have
given it. A limit that is read is honoured; a limit that is mentioned where
the compiler cannot read it is not.

The number of connections is also the limit the process is given for open
files, because facil.io lowers that limit to the capacity of its table. A
program that opens more files than that has to say so, the same way it has to
say how many connections it wants.

## The event loop's tick

The loop waits for an event for a tick and then looks at what it was asked to
do. The loop is stopped from another thread, and the thread that waits for the
event is not woken by the request: it notices the request when the wait is
over. The tick is therefore the shortest a program waits for its server to end,
and it is paid on every run of a program that starts a server and closes it
again — which is what a program that serves a client of its own does.

The runtime is built with `-DFIO_POLL_TICK=1`, so the wait is a millisecond
rather than the ten the runtime used to wait for, and rather than the second
facil.io waits for by itself.

The cost of the shorter tick is a wake of the loop a thousand times a second
while it has nothing to do: a thread that wakes, looks, and sleeps again. A
server that idles for three seconds spends about twenty milliseconds of system
time on it, against the ten a tick of ten milliseconds would spend.

### The wake the tick used to be

The tick was the *only* thing that ended the wait, because facil.io has no way
to wake a loop that is waiting for an event from another thread: `fio_stop()`
clears the flag the loop reads and there the stop waits for the tick. A program
that serves ten requests and stops its server spends about 1.2 milliseconds
waiting for the end of the tick, which is a fifth of what such a program spends
on the whole run, and it is paid for a server that has already answered
everything it was asked.

The wait is a wait on a descriptor, so the adapter makes a pair of them with
`socketpair`, gives one to the loop with `fio_attach_fd`, and writes a byte to
the other where the server is stopped. The loop is woken, finds that it was
asked to stop, and ends. The descriptor is closed once the loop it woke has
ended.

Measured on the benchmark's `./program 10`, with the phases timed from inside
the program and sixty runs of each form taken:

| The stop and the join after it | the usual run | the best run |
|---|---|---|
| the loop woken by the tick | 1.20 ms | 1.07 ms |
| the loop woken by the descriptor | 0.89 ms | 0.18 ms |

What is left of the wait is facil.io's defer thread pool: the loop runs on four
threads by default, and a thread that has nothing to do sleeps for as long as
134 milliseconds between looks at whether it was asked to stop. A program that
says nothing about its server is given four of those threads, and a stop pays
for them — the descriptor wakes the loop, and the loop then waits for the pool
it started. The same program stopped with `-DFIO_DEFER_THROTTLE_LIMIT=125000`,
so that no thread sleeps longer than an eighth of a millisecond, spent 0.30 ms
on the stop instead of 0.89. That is written down here rather than fixed,
because a thread that sleeps for less is a thread that wakes more while the
server is idle, and because making the server one thread is a decision about
how many requests it answers at once, and neither is a decision this spec makes
for a program that stated nothing.

## TLS

TLS is OpenSSL, and OpenSSL is a library the program loads before it runs and
carries in its binary. A program that never speaks TLS pays for the load and
neither the load nor the library is worth what it costs.

So the TLS backend is chosen rather than assumed:

| the program | the runtime carries | the program links |
|---|---|---|
| speaks no TLS | `fio_tls_missing.c`, the same API with nothing behind it | nothing |
| speaks TLS | `fio_tls_openssl.c` | `-lssl -lcrypto` |

A program that asks for a server that speaks TLS is a program the runtime was
built for, so the compiler reads the question off the program: `http.serveTls`
in the body of the program, or in the source of any file of it.

### The transport a request is asked over

The other half of the question is the requests the program makes: a client that
asks a server over `https://` speaks TLS to it, and a client that asks one over
`http://` does not. The URL a request names is where that is written, and the
first version of the rule read it as a text the source spells out *in full* — a
URL with nothing interpolated into it. The benchmark asks its server over

```ts
const api = `http://${host}:${port}/`;
```

which is a URL with two things interpolated into it, so the rule could not read
it and gave the program the backend that can speak either. The program linked
OpenSSL, loaded six megabytes of it before it ran, and paid about 1.3
milliseconds of a seven millisecond run for a library it never called.

The scheme is the part of a URL that decides the transport, and it is the part
a program writes out in full even when the rest of the URL is put together
while the program runs: `http://${host}:${port}/` is a request over plain text
whatever the host and the port are. So the rule reads the scheme the URL
begins with — the parts of a text that are written, up to the first that is
computed — and a URL whose beginning is not written out is still a URL the
compiler cannot decide on:

| what the program writes | the runtime carries |
|---|---|
| `"http://127.0.0.1:8080/"` | no TLS |
| `` `http://${host}:${port}/` `` | no TLS |
| `` `https://${host}/` `` | TLS |
| `` `${base}/${path}` `` | TLS |

A URL a program names is read from the URL the name was bound to, so
`const api = …; http.request(api, …)` is the request the name is. The body is
walked twice for it: once for the URLs it binds to names and once for the calls
it makes, because a name may be bound after the function that asks through it
is written. A name the program may write again holds the URL the program chose
rather than the one it was declared with, and that is a URL the compiler cannot
read.

The two changes together take the benchmark from 6.9 milliseconds to 5.4 on
this machine, and the smallest of three hundred runs of each from 6.2 to 4.0:
the library the program no longer loads is the larger half of it.

The runtime that carries no TLS says so plainly rather than serving plain HTTP
to a program that asked for another thing:

```
blaze: this program was built without TLS, so it cannot serve HTTPS
```

## The pool of free memory

facil.io keeps the memory it allocates between the things it allocates in a
pool of blocks, and it takes the blocks of that pool a megabyte at a time. The
pool is mapped and unmapped again before the program answers its first
request, so a pool of eight megabytes — what facil.io asks for by itself — is
eight megabytes the program pays for and never fills.

The runtime is built with `-DFIO_MEMORY_BLOCKS_PER_ALLOCATION=32`, so the pool
is a megabyte: large enough that a server under load does not ask the system
for memory on every connection, and small enough that the program does not pay
for the pool before it has served anything.

## The addresses of a host

The client of the runtime looks a host up before it connects to it, and the
lookup reads the files of the resolver and asks the resolver itself. A program
that opens a connection to the same host again pays for it again.

The answers are kept instead, one per host and port, so that the second
connection to a host is opened as soon as the first one was. A lookup that
failed is not kept: a host that does not answer yet may answer later, and a
program that gave up on it the first time would never reach it at all.

## The addresses a server answers on

A server may be told the address it listens on: the second argument of
`server.listen(port, host, callback)` is the host, and an IPv6 address is
written as it is written in a URL, between brackets — `server.listen(8080,
"::1", …)` names the IPv6 loopback and `server.listen(8080, "127.0.0.1", …)`
the IPv4 one. The runtime copies the host before it binds, so the text the
program wrote is not needed after the call.

A server the program names no address for — `http.serve`, `http.serveTls`, or
a `server.listen` whose host is empty — listens on every address of both
families. The adapter binds the unspecified IPv6 address and the IPv4
wildcard. On a machine where an IPv6 socket accepts IPv4 connections the
second bind finds the port already held, and the first listener serves both;
on a machine where the two are separate sockets, or where IPv6 is not there
at all, the listeners that did bind serve the families they are. A bind that
fails because another listener already holds the port is the bind that had
nothing left to add.

The client writes an address the same way a URL does. A request to
`http://[::1]:8080/` is made to the IPv6 loopback, and the `Host` header of
the request carries the authority as the URL wrote it: `[::1]:8080`. The
brackets belong to the header and not to the address, so the resolver and
the certificate check are given the address itself.

## What the compiler writes out of a string

A string the program builds is a list of pieces, and a backend writes it out
by concatenating the pieces one at a time. Two pieces of text written next to
each other are one piece of text, and a piece that is itself a string written
out in full is that string written out.

So the optimizer joins the pieces of a string that are written out
(`semantics/optimize-ir.ts`), and a string added to a string is folded when
both of them are written out. A URL written as

```ts
const api = `http://${host}:${port}/`;
```

is written out as two pieces and a number rather than as four pieces and a
number, and the header of a request is written out as one literal rather than
as a concatenation of two of them.

The pieces are the same string either way: the text is the text, and the
pieces it is written out of are how it was written rather than what it is.

## What is left

The benchmark's five and a half milliseconds, timed from inside the program
with the smallest of sixty runs of each phase:

| the phase | what it costs |
|---|---|
| the process, before `main` and after it | about 2.2 ms |
| the ten requests | 1.1 ms |
| the server's own creation and its listener | 0.36 ms |
| the stop and the join | 0.29 ms |

- **The process itself is the largest half.** A program that prints nothing
  and exits costs 0.7 ms on this machine; this one costs 2.3 ms outside
  everything it measures of itself, and the dynamic loader is only 50
  microseconds of that. What is left is the pages of a binary of 355 KB, the
  four thread stacks facil.io asks for, and the unmapping of the pool and the
  table of connections at exit.

- **The first request costs 0.58 ms and each of the next nine costs 0.065 ms.**
  Most of the first is `getaddrinfo("localhost")`, which reads the files of the
  resolver, asks it over netlink and sorts the addresses of the host by a rule
  that probes the source address of both families: 90 microseconds in a program
  of its own and 250 in the first thing this process does with it. A host that
  is an address needs none of it (`AI_NUMERICHOST`), and the benchmark's host
  is a name.

- **A request is two thread handoffs.** The client of a program blocks on the
  answer, and the answer is written by the loop on another thread: sixty-five
  microseconds per request is what the two schedules and facil.io's parsing of
  a request and its answer cost. A program that serves five hundred requests
  spends thirty milliseconds in them, which is what the number is worth.

- **The loop's threads.** The wake above leaves the defer threads' sleep as
  the rest of the stop, and they are four because the machine has four cores.
  A program that says nothing about its server is given them; see the tick
  above for why that is not changed here.


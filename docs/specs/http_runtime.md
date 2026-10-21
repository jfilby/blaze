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

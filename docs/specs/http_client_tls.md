# The HTTP client speaks TLS

## What it is

The HTTP facility has a client: `http.request(url, method, headers, body)` is
one synchronous request, and `http.request(url, options, callback)` is one
buffered request whose `req.write`, `req.end` and `res.on` write and read it.
The client is the runtime's own, written over sockets rather than over
facil.io's own client, which is asynchronous where a program's request is
synchronous.

Until now the client asked only over "http://". A URL of "https://" was
parsed for its host, port and path and then written to the port as if it were
plain HTTP: the peer read bytes it could not read, and the request failed.
This is what the client speaks TLS for, and this document is what it took.

## The shape of it

A connection that speaks TLS is a connection to a different server than a
plain one to the same host and port. So the connection the client keeps open
between two requests carries the scheme beside the host and the port, and a
cached plain connection is not handed to a request of "https://".

The TLS session is OpenSSL's:

| Step | What it does |
|---|---|
| `SSL_CTX_new(TLS_client_method())` | the context every session of the client is made of; it is made once and kept |
| `SSL_CTX_set_default_verify_paths(ctx)` | the trust store is the one of the machine |
| `SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL)` | the certificate of the peer is checked |
| `SSL_new(ctx)`, `SSL_set_fd(ssl, sock)` | a session over the connection that was opened |
| `SSL_set_tlsext_host_name(ssl, host)` | the server is told which name it is asked for |
| `SSL_set1_host(ssl, host)` | the certificate of the server is checked against the name the request names |
| `SSL_connect(ssl)` | the session is up, or the request fails |

After the handshake the bytes are moved by `SSL_write` and `SSL_read`
instead of `send` and `recv`. The functions that move them take the
connection they move them over, which is a socket and a session, so the same
request, the same chunked reader and the same response reader ask over either.

## Where it is guarded

The TLS code is guarded by `BLAZE_HTTP_TLS`, the flag the runtime is built
with for a program that speaks TLS. A program that speaks no TLS carries
neither the library nor the code that uses it, and the code that asks a
server over TLS is not even in its runtime: the guard is the reason the
program that asks no TLS pays for neither.

## What decides TLS

`runtime/http-needs.ts` answers two questions about a program: how many
connections its server may hold, and whether it speaks TLS. The second is
decided by the program itself, in two ways:

| the program | the runtime carries |
|---|---|
| `http.serveTls` in its source | `fio_tls_openssl.c`, and `-lssl -lcrypto` |
| `https://` in its source | the same, and the client's handshake |

The rule is the source-word rule the SQLite facility uses: the word in the
source is what says so. `runtime/http-needs.ts` answers the question with
`speaksTlsToServer(source)`, and the build asks it with the source of the
program and the sources of the files of it — the program's own source among
them, because the URL the client asks is written in the body the program is.

A URL that is written in a comment is a program that speaks TLS as far as the
rule is concerned, and that is the trade the rule has always made: the word
is what says so, and a comment is written in the source.

## What a failure is

| What fails | What the program sees |
|---|---|
| the certificate of the server is not trusted | the request answers nothing |
| the handshake does not finish | the request answers nothing |
| the session is closed by the peer mid-answer | the request fails |

`blaze_http_client_request` answers `NULL` for all of them, and a program
that asks for a response it did not get reads nothing out of it. The reason
is not carried back: a handshake that failed is a thing of the machine it
happened on, and the runtime has no place to put a reason that a program
could read.

## What the client keeps

The connections the client keeps are the same table they were, with the
scheme beside the host and the port in each entry. A TLS session is freed
when the connection it was over is closed, and the context it was made of is
kept for every connection after it: the context holds the trust store, and a
context per connection would load the trust store again for every request.

A connection the peer closed while it was idle is closed by the client before
it is handed to a request, the way a plain one is — but a TLS connection is
not asked, because the bytes of it are inside the session and not on the
socket, and a socket that holds nothing is not a session that was closed. A
request that fails on a closed session is asked for again on a new one, which
is what the request does with a connection that failed it.

## Tests

- `test/http-tls.test.ts` — that a source which names an "https://" URL
  speaks TLS to a server, that the needs of such a program carry TLS, and
  that the adapter source carries the handshake, guarded by the flag.
- The handshake itself was exercised by hand: a self-signed certificate was
  made for `localhost`, a TLS server was stood up behind it, a program that
  asks `https://localhost:<port>/` was built, and it was run with
  `SSL_CERT_FILE` naming the certificate. It printed what the server
  answered, and it printed nothing when the certificate was not in the trust
  store.

## What is not done

- **The reason a handshake failed is not carried back.** A program that asks
  a server that does not answer is told that nothing was answered, and not
  why.
- **The client does not verify a certificate against a named authority.**
  The trust store is the one of the machine, and the machine is told about a
  certificate that is not in it by `SSL_CERT_FILE`, which is how a program
  that asks a server of its own is tested.
- **The client does not ask over HTTP/2.** TLS is negotiated with ALPN left
  empty, so a server that speaks both answers with HTTP/1.1, which is the
  protocol the client reads.

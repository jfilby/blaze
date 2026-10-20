# A Blaze HTTP server whose handler is a module

A server in two files:

| File | What it is |
|---|---|
| `main.ts` | the body of the program: it starts the server and hands it the handler |
| `handler.ts` | a module: the handler, compiled on its own and linked beside the program |

The handler is a *module function*, so it is compiled by the backend the
project names — `backend = "machine"` above, `backend = "c"` for the other one
— and the same source is served by both. The answers the two give are the
answers the server gives: the same status, the same headers and the same body.

The HTTP API a module function has:

| Call | What it does |
|---|---|
| `http.requestPath(req)` | the path the request was sent to, as text |
| `http.requestMethod(req)` | the method it was sent with, as text |
| `http.requestHeader(req, name)` | the value of a header, as text |
| `http.requestBody(req)` | the body of the request, as text |
| `http.responseStatus(res, status)` | the status the response is answered with |
| `http.responseHeader(res, name, value)` | a header of the response |
| `http.responseEnd(res[, body])` | the body of the response, and the end of it |

The request and the response are borrowed: they are the runtime's own, and they
are there for as long as the request is being served.

## The routes

| Route | What it answers |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `POST /echo` | `{"echo":<the body that was posted>}` |
| anything else | `{"error":"not found"}`, with a 404 |

## Running it

```sh
cd src/programs/http-module
blaze build          # builds with the backend the project names
./http-module 8080   # serves on http://127.0.0.1:8080/

curl -s http://127.0.0.1:8080/health
curl -s -X POST -d '{"a":1}' http://127.0.0.1:8080/echo
```

The port is the first argument; without one the server listens on 8080.

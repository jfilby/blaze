# The HTTP API of a module function

## What it is

A Blaze program that serves HTTP is a **program body** and a **module**:

| Part | Where | What it is |
|---|---|---|
| the body | the entry file | the statements that run: it starts the server and hands it the handler |
| the module | a file beside it | the functions the program calls, one of which is the handler |

A module is compiled on its own — by the C backend or by the machine backend,
as the project names — and the program links it beside itself. The handler is
therefore the same code whichever backend built it, and the answers the two
give are the answers the server gives.

This is what was missing: the HTTP API was available to a program body only,
and a program body is written as C. The machine backend lowers the functions
of a *module*, so a program that serves HTTP could not be served by it.

The example is `src/programs/http-module/`: a health endpoint and an echo of
what was posted, in two files, served by both backends.

## The API

The calls a module function may make are the HTTP ABI (`runtime/http.ts`) under
names of their own:

| Call | What it does |
|---|---|
| `http.requestPath(req)` | the path the request was sent to, as text |
| `http.requestMethod(req)` | the method it was sent with, as text |
| `http.requestHeader(req, name)` | the value of a header, as text |
| `http.requestBody(req)` | the body of the request, as text |
| `http.responseStatus(res, status)` | the status the response is answered with |
| `http.responseHeader(res, name, value)` | a header of the response |
| `http.responseBody(res, body)` | the body of the response |
| `http.responseEnd(res[, body])` | the body of the response, and the end of it |

The request and the response are **borrowed**: they are the runtime's own, and
they are there for as long as the request is being served. The text a call
hands back is borrowed from the request as well, and the runtime copies what it
hands out into the memory the request owns, so a handler that reads two
headers holds both of them.

The names are the compiler's, not the source's: a program body has its own
spelling of the same things (`req.path`, `res.end(body)`), and the two are
separate because the two carry their handles differently — a program body holds
a handle in a dynamic value, and a module function holds it in a reference.

## The bridge

The runtime calls a handler with the request and the response and nothing else:

```c
typedef void (*blaze_http_handler)(blaze_http_request* request, blaze_http_response* response);
```

A handler of another file of the program is compiled on its own and linked
beside the program, so the driver writes the bridge between the two:

```c
static void blaze_http_bridge_handler(void *request, void *response) {
  handler(request, response);
}
```

Which of the two it is depends on the backend that compiled the handler, and
the driver is told which that is:

- the **machine** backend carries a reference as the address itself, so the
  bridge hands the addresses over as they are;
- the **C** backend carries a reference as the double a program holds one in,
  so the bridge reads the address out of it.

The handler is written by the source as `function handler(req: any, res: any)`,
and the driver refuses a handler whose parameters are not references: a handler
is given the request and the response, and nothing else is a handler.

## What the compiler had to be able to do

1. **A call of a namespace.** A module function may only call a function of
   the program it is part of, and `Math.floor(x)` was the one name of that kind
   there was. `http` is a namespace now, and a call of it is a call of the
   name the namespace and the member spell together.

2. **A builtin that hands back a string.** The HTTP calls that read the
   request hand back text, and a text is a type the contract language does not
   spell: the builtin's answer is a text, and what a use infers of it is the
   same as what it infers of any other reference.

3. **A function of another file as a value.** A program body may name a
   function of another file of the program and hand it over, and the driver
   links it and hands the runtime its address.

4. **A reference in a machine function.** A reference is a pointer in the
   machine backend, and the HTTP calls hand the runtime's own addresses over
   as they are.

## What is not done

- **A handler that returns early.** A function of a module hands back a value,
  and a function that returns nothing cannot say `return;` — it falls off the
  end. A handler that answers one route and stops has to answer the other
  route in the other arm.

- **The state a handler shares.** A name a handler captures is a copy, and the
  handler of a server runs on the runtime's own thread, so what it writes has
  to be seen by the program that owns the state. The state of a program lives
  in an array, and a module function is given one as a parameter.

- **The length of a body is not part of the API.** The body of a request is
  read as text, and a body that carries a NUL is cut short at it. The runtime
  knows the length — the HTTP ABI hands it out — and a call that wants it is
  not written yet.

- **No streaming.** The body of a response is written before the response is
  sent, and there is no event stream for a module function: the event stream
  the program body has is the runtime's own.

- **The program body still holds the server.** The module answers the
  requests and the body starts the server, and the body is written as C. A
  module that starts the server itself is not something the API has.

# The Blaze website

## What it is

A website about Blaze: an introduction to the compiler and a chat that
answers questions about it. It is itself a Blaze program — a TypeScript
source compiled to a native binary that serves its own pages over HTTP, asks
a model on Nebius Token Factory to answer the questions, and saves every
question and answer to a SQLite database.

The program lives in `src/programs/blaze-website/`, and it is built the way
the pulse program is: `main.ts` beside `web/`, with the HTTP runtime and the
SQLite library linked beside the binary the compiler delivers.

## The parts

| Part | Where | What it is |
|---|---|---|
| The server | `src/programs/blaze-website/main.ts` | the routes, the model, the database |
| The website | `src/programs/blaze-website/web/` | HTML, CSS and vanilla JavaScript |
| The configuration | `config.toml` in the working directory | the endpoint and the model |
| The key | `NEBIUS_API_KEY` in the environment | the API key of Nebius Token Factory |
| The database | `chats.db` in the working directory | every chat, saved when it is answered |

## The routes

| Route | Method | What it answers |
|---|---|---|
| `/` | GET | the home page |
| `/chat` | GET | the chat |
| `/app.js`, `/style.css` | GET | the website's own files |
| `/api/chat` | POST | the question, as the plain-text body; the model's JSON answer |
| `/api/resume/<id>` | GET | the transcript of the thread a saved chat belongs to |
| `/api/chats` | GET | the last ten saved chats, newest first, as a JSON array |

Anything else is a 404.

## The chat

The question arrives as the body of the request, plain text:

```sh
curl -X POST http://127.0.0.1:8080/api/chat -d "What is Blaze?"
```

The program asks the model with it, over TLS, and returns the model's JSON
answer to the browser, which reads the answer out of
`choices[0].message.content` the way JavaScript reads JSON. The question and
the answer are saved to SQLite in the same request, so a chat that is asked
is a chat that is saved.

A saved chat can be resumed. Every question and answer is a row of the
`messages` table, and the thread a row belongs to is the id of the question
that began it — the chats of the schema before threads are copied in once,
each as its own thread, with a marker in a `meta` table saying the copy ran.
Resuming a saved chat reads its thread back as a transcript, and the
questions asked afterwards name the thread in front of themselves, as
`T<thread>\n<question>` — the rest of the body is the question, which is
what a plain-text body can carry without a JSON field to read. The model is
given the conversation so far: the last ten turns of the thread, oldest
first, with the content of every earlier answer read out of the JSON it was
saved as, by parsing the reply and reading `choices`, the first element of
the array, `message` and `content` off it — a read the compiler's
`JSON.get` answers, over a dynamic value whose handle the program carries.
A fresh question begins a thread of its own.

The model is `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, the cheapest
text-to-text model on Nebius Token Factory when this was written: 0.06 per
million input tokens and 0.24 per million output tokens. The model and the
endpoint are named in `config.toml`.

The Nebius API key is server-side only: the program reads it from the
`NEBIUS_API_KEY` environment variable when it starts, and nothing about it
ever reaches the browser. Every answer comes back through the Blaze program,
and every chat the program answers is saved to SQLite — a chat that is asked
is a chat that is saved. A chat asked without the key, or without the
configuration, is answered with the error that says so, as JSON the browser
shows.

## The database

Two tables: the chats of the schema before threads, which are copied into
the messages once, and the messages themselves.

```sql
CREATE TABLE IF NOT EXISTS chats (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT,
  answer   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread   INTEGER,
  question TEXT,
  answer   TEXT
);
```

The connection is opened when the program starts and is used by every
request that reads it or writes it. The runtime serves the handlers of a
server on its own threads, and a connection is not shared between two of
them, so the program opens the one connection and the requests that use it
arrive one at a time — a website whose chat is asked one question at a time.

## The model is asked over TLS

The endpoint is `https://api.tokenfactory.nebius.com/v1/chat/completions`,
and the runtime's HTTP client speaks TLS to it — see
[`docs/specs/http_client_tls.md`](./http_client_tls.md). The program's
source names the URL, which is what tells the compiler to build a runtime
that carries OpenSSL, and the request is one synchronous `http.request`.

## The constraints the program works within

These are the compiler's rules, and the program is written to them.

- **A field of a parsed JSON object is read as the number it is.** The
  runtime answers a field of an object it holds with the number of the
  value, and the number of a text is what `atof` reads off it — so the
  question of a JSON body would be read as the number zero. The question
  arrives as the plain-text body of the request instead, and the model's
  answer travels to the browser as the JSON it is.
- **The state of a program lives in an array or a global text.** The JSON
  the `/api/chats` route answers is built into a global text
  (`chatsJson`) by a function the handler calls, the way the pulse program
  builds its snapshot.
- **A function of a program hands back a number or a reference, and not a
  string.** The JSON of the saved chats is written into a name of the
  program's own and read from there.
- **A command-line argument is read as a number.** `ARGV(n)` answers the
  number an argument states, and an argument that is not a number at all is
  NaN — so the port is read off the command line and the API key is not: the
  key is read from the environment, because a key is text.
- **An error is an error.** The endpoint that is not configured and the key
  that is not set are answered with the error that says so, as JSON the
  browser shows, rather than a chat answered with nothing.

## How to run it

The README of the program has the commands:

```sh
cd src/programs/blaze-website
blaze build
export NEBIUS_API_KEY="your-token-factory-key"
./blaze-website 8080
```

The build of this project sets `verifyProgram = false`, the setting that asks
a build to deliver the program without running it against its source. The
check compares what the source prints with what the delivered program prints,
and this program has nothing the build could compare: it reads its key from
the environment and its endpoint from a file that are beside it when it runs
and not when it is built, so the delivered program cannot be compared with
the source's output. A program that serves rather than prints is the other
kind that asks for this, and the benchmark programs are the ones that set it.

## What is not done

- **The website has never been rendered in a browser.** The routes, the
  content types and the JavaScript are checked against what the program
  answers; the layout and the chat transcript are not.
- **There is no end-to-end test of the program.** The compiler's suite
  covers the features the program needs — the HTTP runtime, TLS to a server,
  SQLite — but nothing asserts the website's own routes or the chat flow.
- **A fresh question starts a thread of its own.** The conversation so far
  is only behind a question that resumes a saved chat: a run of fresh
  questions is a run of one-turn chats, and continuing one of those means
  resuming it.
- **The model is called from the server.** The Nebius call happens inside the
  program, key and all, and the browser only talks to the program: nothing
  about the key or the model's stream reaches the visitor's page.

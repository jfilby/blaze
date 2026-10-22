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
| The key | `NEBIUS_API_KEY` in the working directory | the API key of Nebius Token Factory |
| The database | `chats.db` in the working directory | every chat, saved when it is answered |

## The routes

| Route | Method | What it answers |
|---|---|---|
| `/` | GET | the website |
| `/app.js`, `/style.css` | GET | the website's own files |
| `/api/chat` | POST | the question, as the plain-text body; the model's JSON answer |
| `/api/chats` | GET | every saved chat, newest first, as a JSON array |

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

The model is `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, the cheapest
text-to-text model on Nebius Token Factory when this was written: 0.06 per
million input tokens and 0.24 per million output tokens. The model and the
endpoint are named in `main.ts`.

The browser can ask the model itself, when the visitor pastes a Token
Factory key into the page: then the question streams straight from the
browser to Nebius Token Factory, token by token, through the Vercel AI SDK
(`createOpenAI` pointed at the Token Factory endpoint, `streamText` over the
question). Token Factory allows a browser to ask it — `access-control-allow-origin`
is `*` — so the page can hold the key and the stream both. A chat asked that
way is not saved, because the question and the answer would have to travel
to the program in a form the program could tell apart, and the text of a
program is not cut.

## The database

One table, of the chats:

```sql
CREATE TABLE IF NOT EXISTS chats (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
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
  key is read from a file, because a key is text.
- **An error is an error.** The API key that is not there is a runtime
  failure, which stops the program rather than answering a chat with an
  error message, so the key file must exist when the program starts.

## How to run it

The README of the program has the commands:

```sh
cd src/compiler
node offline-build.ts ../programs/blaze-website /tmp/blaze-website-work
cd ../programs/blaze-website
printf %s "your-token-factory-key" > NEBIUS_API_KEY
/tmp/blaze-website-work/program 8080
```

Open <http://127.0.0.1:8080/> in a browser.

## What is not done

- **The website has never been rendered in a browser.** The routes, the
  content types and the JavaScript are checked against what the program
  answers; the layout and the chat transcript are not.
- **There is no end-to-end test of the program.** The compiler's suite
  covers the features the program needs — the HTTP runtime, TLS to a server,
  SQLite — but nothing asserts the website's own routes or the chat flow.
- **The chat is not conversational.** Every question is asked on its own:
  the model is not given the chat so far. A chat that remembers would build
  the request the way the model asks for a conversation, and the text of an
  answer would have to be escaped before it is written into the JSON of the
  request, which the program has no way to do yet.
- **A chat the browser streamed itself is not saved.** The question and the
  answer would have to travel to the program in a form the program could
  tell apart, and the text of a program is not cut: there is no `indexOf` of
  a text, so a body of `question\n\nanswer` cannot be told apart into its
  two halves.
- **The key is read from a file, not the environment.** The runtime of a
  program has no `process.env` yet, so the API key is read from a file.
- **The key file must exist when the program starts.** A file that is not
  there is a runtime failure, and a program body cannot catch one.

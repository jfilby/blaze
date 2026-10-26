# Blaze website

A website about Blaze: an introduction to the compiler and a chat that
answers questions about it. The website is itself a Blaze program — a
TypeScript source compiled to a native binary that serves its own pages over
HTTP, asks a model on Nebius Token Factory to answer questions, and saves
every question and answer to a SQLite database.

- `main.ts` — the program: the server, the routes, the model, the database.
- `web/` — the website: HTML, CSS and vanilla JavaScript.
- `config.toml` — the endpoint the chat asks and the model it asks there
  (not committed; create it yourself).
- `NEBIUS_API_KEY` — the environment variable the Nebius Token Factory API
  key is read from (set it yourself; the key is never in a file).
- `chats.db` — the SQLite database every chat is saved to (created when the
  program starts).

## Building

The program is built by Blaze, with the facil.io HTTP runtime vendored into
it and the SQLite library linked beside it:

```sh
cd src/programs/blaze-website
blaze build
```

The binary is delivered beside the project file as `blaze-website`. The build
does not run the program to check its output against the source, because the
program reads its key from the environment and its endpoint from a file that
are beside it when it runs and not when it is built, so there is nothing the
build could compare; the project file says so with `verifyProgram = false`,
the setting a program that prints nothing to compare asks for.

## Compile time

LLM use at compile time is optional. Building `blaze-website` does not call a
model, does not need an API key, and works without any model access: you can
run `blaze build` with no key and no network to a model endpoint.

The only place a model is used is at runtime. When the chat is asked a
question, the program itself calls the Nebius Token Factory model, and that
call needs `NEBIUS_API_KEY` — but only when the program runs, never when it is
built.

## Running

The program reads its own files from `web/`, the endpoint and the model from
`config.toml`, and the API key from the environment:

```sh
cd src/programs/blaze-website
export NEBIUS_API_KEY="your-token-factory-key"
./blaze-website 8080
```

`config.toml` names the endpoint and the model:

```toml
endpoint = "https://api.tokenfactory.nebius.com/v1/chat/completions"
model = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
```

The API key is never in a file the project carries: it comes from the
`NEBIUS_API_KEY` environment variable, which the program reads when it
starts. A chat asked without it is answered with the error that says so, as
JSON the browser shows — and nothing about the key ever reaches the browser.

The port is the first argument, and it is 8080 when no argument is given. The
message the program writes is printed when it starts.

Open <http://127.0.0.1:8080/> in a browser.

## The routes

| Route | Method | What it answers |
|---|---|---|
| `/` | GET | the website |
| `/app.js`, `/style.css` | GET | the website's own files |
| `/api/chat` | POST | the question, as the plain-text body; the model's JSON answer |
| `/api/chats` | GET | every saved chat, newest first, as a JSON array |

Anything else is a 404.

## The chat

The question arrives as the body of the request, plain text. The program
asks the model with it, saves the question and the model's JSON answer to
SQLite, and returns the JSON answer to the browser, which reads the answer
out of `choices[0].message.content` the way JavaScript reads JSON.

The model is `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, the cheapest
text-to-text model on Nebius Token Factory at the time this was written:
0.06 per million input tokens and 0.24 per million output tokens. The model
and the endpoint are named in `config.toml`, so a different model or endpoint
is one edit away.

The Nebius API key is server-side only: the program reads it from the
`NEBIUS_API_KEY` environment variable, and nothing about it ever reaches the
browser. Every answer comes back through the Blaze program, and every chat
the program answers is saved to SQLite.

## What the program works within

These are the compiler's rules, and the program is written to them.

- **The state of a program lives in an array or a global text.** A name a
  handler captures is a copy unless it is an array or a string, so the JSON
  the `/api/chats` route answers is built into a global text
  (`chatsJson`) by a function the handler calls, the way the pulse program
  builds its snapshot.
- **A field of a parsed JSON object is read as the number it is.** The
  runtime answers a field of an object it holds with the number of the
  value, and the number of a text is what `atof` reads off it: so a question
  read out of a JSON body would be read as the number zero. The question
  arrives as the plain-text body of the request instead, which the program
  reads as the text it is, and the model's answer travels to the browser as
  the JSON it is.
- **A function of a program hands back a number or a reference, and not a
  string.** The JSON of the saved chats is written into a name of the
  program's own and read from there.
- **An error is an error.** The endpoint that is not configured and the key
  that is not set are answered with the error that says so, as JSON the
  browser shows, rather than a chat answered with nothing.

## What is not done

- **The website has never been rendered in a browser.** The routes, the
  content types and the JavaScript are checked against what the program
  answers; the layout and the chat transcript are not.
- **There is no end-to-end test of the program.** The compiler's suite
  covers the features the program needs — the HTTP runtime, TLS to a server,
  SQLite — but nothing asserts the website's own routes or the chat flow.
- **The chat is not conversational.** Every question is asked on its own:
  the model is not given the chat so far, so a question that says "it" has
  nothing behind the word to point at. A chat that remembers would build the
  request the way the model asks for a conversation, and the text of an
  answer would have to be escaped before it is written into the JSON of the
  request — which the program now can, with `jsonEscape`.

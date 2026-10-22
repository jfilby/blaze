# Blaze website

A website about Blaze: an introduction to the compiler and a chat that
answers questions about it. The website is itself a Blaze program — a
TypeScript source compiled to a native binary that serves its own pages over
HTTP, asks a model on Nebius Token Factory to answer questions, and saves
every question and answer to a SQLite database.

- `main.ts` — the program: the server, the routes, the model, the database.
- `web/` — the website: HTML, CSS and vanilla JavaScript.
- `NEBIUS_API_KEY` — the file the Nebius Token Factory API key is read from
  (not committed; create it yourself).
- `chats.db` — the SQLite database every chat is saved to (created when the
  program starts).

## Building

The program is built by Blaze, with the facil.io HTTP runtime and the SQLite
library beside it:

```sh
cd src/compiler
node offline-build.ts ../programs/blaze-website /tmp/blaze-website-work
```

The binary is written to the work directory as `program`.

## Running

The program reads its own files from `web/`, so it is started from the
directory that holds it, and the API key from `NEBIUS_API_KEY` in that
directory:

```sh
cd src/programs/blaze-website
printf %s "your-token-factory-key" > NEBIUS_API_KEY      # no newline
/tmp/blaze-website-work/program 8080
```

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
and the endpoint are named in `main.ts`, so a different model or endpoint is
one edit away.

The browser can ask the model itself, when the visitor pastes a Token
Factory key into the page: then the question streams straight from the
browser to Nebius Token Factory, token by token, through the Vercel AI SDK
(`createOpenAI` pointed at the Token Factory endpoint, `streamText` over the
question). A chat asked that way is not saved, because the question and the
answer would have to travel to the program in a form the program could tell
apart, and the text of a program is not cut. The chat that goes through the
program is the one that is saved.

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
- **An error is an error.** The API key that is not there is a runtime
  failure, which stops the program rather than answering a chat with an
  error message, so the key file must exist when the program starts.

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
  request the way the model asks for a conversation, which is work for the
  JSON the program cannot write without escaping the text of the answer.
- **The key is read from a file, not the environment.** The runtime of a
  program has no `process.env` yet, so the API key is read from a file
  instead of an environment variable: `fs.readFileSync("NEBIUS_API_KEY")`.

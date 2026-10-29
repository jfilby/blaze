# About

## Install

```
git clone git@github.com:jfilby/blaze.git
cd blaze/src/compiler
npm install
npm link          # optional: puts `blaze` on your PATH
```

The link is a symlink to cli.ts, so the node on your PATH must be the >= 22.18
one.

Verify the install with `blaze --help`.


## Inspiration

Now that AI has become capable of coding we should raise our ambitions. Blaze
is an experiment in writing a compiler for languages like Python and
TypeScript, that generates very fast machine code (and other backends).

My research found that this is possible with the right approach.


## What it does

The compiler uses an internal representation (IR) language to support multiple
frontends compiled to multiple backends.

Use of AI (e.g. Nemotron models via Nebius Token Factory):
- Programs can be compiled with an AI model specified in blaze.toml to perform
compile-time optimizations. This is useful for logs to boost agentic coding.
- The blazeup utility uses AI with the Pi SDK to automate coding loops that
improve the compiler.
- Agentic coding to continue developing the compiler.

A frontend supports a language like TypeScript or Python, but only a subset due
to time and resource constraints. Backends are the output, with C and machine
code the current focus.

Initial support for Nim and WASM backends is available, but not yet on par
with the others due to time constraints.

To achieve this functionality Blaze has an IR notation. Frontend languages are
first compiled to the IR, before the IR is compiled to the backend. This helps
to reduce duplicated effort in the compiler.

Blazeup is included, a utility to improve the compiler by taking inputs such as
related research papers identified by Tavily, build artifacts and compiler code
introspection. It uses the Pi SDK, leveraging models such as Nemotron 3.5 Super
VL, to suggest changes, and implemented and test them.

Every backend includes its own runtime services, e.g. common standard library
functions.

Major features:
- Python and TypeScript/JavaScript frontends (subset)
- C and machine code backends (with initial Nim and WASM backends)
- Incremental compilation
- Optimized arithmetic
- Dynamic values (any type)
- JSON parse/stringify
- HTTP server (via facil.io C lib)
- SQLite support (via linked lib)

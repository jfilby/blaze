# Instructions

## Project

This is Blaze, an AI compiler to generate assembly from traditional source.


## Libraries

Make use of:
- Vercel AI SDK


## Vendored dependencies

facil.io is vendored at `deps/facil.io` (pinned to git master) and can be used
as a high-performance HTTP server (plus websockets, JSON helpers, and other
networking utilities it provides).


## Design notes

- Move complexity down where possible.
- Pass data structures instead of using private fields to improve determinism.
- If you need to add features to the compiler, aim for correctness over speed
of implementing those features.


## List of do's

- Do take care not to cause an oom with benchmarking and testing.
- Do use docs/specs to write any helpful specs about the compiler and related
tools (e.g. blazeup).
- Do try to optimize the compiler to generate more performance output.


## List of dont's

- Don't edit example or benchmark programs.
- Don't try to do anything that would require secrets you don't have.
- Don't edit env files, ask the user to do this for you.
- Don't look in archived files, they are assumed to be irrelevant.
- Don't create or edit anything under the private-docs dir.
- Don't modify this AGENTS.md file.


## Specs

The compiler's stages are:

<1. original source, e.g. TypeScript>
  -- rule-based transform -->

<2. IR>
  -- LLM verification and proposed fixes -->

<3. verified/revised IR>
  -- rule-based transform -->

<4. target low-level code, e.g. ASM, WASM, machine code>
  -- LLM verification and proposed fixes -->

<5. verified/revised target low-level code, e.g. ASM, WASM, machine code>
  -- compile -->

<6. binary>


LLMs are used to verify both IR and low-level targets. They do not implement
fixes themselves. Instead, they inspect an artifact and propose fixes. The
rule-based compiler evaluates those proposals and, when they are valid, applies
them by regenerating the artifact.


## Benchmarking

You can use hyperfine to benchmark a program or more than one at a time. E.g.:

```sh
hyperfine --warmup 3 ./binarytrees_machine ./n2
```


## Example and benchmark programs

Use the blaze.toml file of each Blaze program to know what a Blaze build is
made up of. The same dir could contain other programs, typically to benchmark
against.


## Layout

`src/compiler` is the npm package: manifest, lockfile, tsconfig, sources and
tests all live there. Run commands from it.


## Test suite

Don't use a timeout of less than an hour for the test-suite.

For every change or fix, add a test (or tests) to the test suite to prevent
regressions.

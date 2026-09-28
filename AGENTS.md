# Instructions

## Project

This is Blaze, an AI compiler to generate assembly from traditional source.


## Layout

`src/compiler` is the npm package: manifest, lockfile, tsconfig, sources and
tests all live there. Run commands from it.
- `npm run typecheck`, `npm test`, `npm run aic -- <args>`
- A program becomes the semantic IR (`core/semantic-ir.ts`) before any target
  code is generated: `semantics/ir-resolve.ts` writes it, `ir-validate.ts`
  checks it, `ir-text.ts` prints and reads it, and `blaze ir` shows it.
- Every output kind answers in that IR, and the compiler lowers it: `ir`
  delivers it as written, `c` emits it as C, `asm` and `machine` as assembly and
  an object, and `wasm` as a WebAssembly module (`toolchain/ir-wasm.ts`, which
  encodes the module itself and needs no wasm toolchain). A candidate is read,
  checked against its contract and lowered on the one path in
  `codegen.ts:materialize`, so a rule the lowering enforces is never a rule
  the model has to learn.


## Libraries

Make use of:
- Vercel AI SDK


## Design notes

- Move complexity down where possible.
- Pass data structures instead of using private fields to improve determinism.


## List of dont's

- Don't try to do anything that would require secrets you don't have.
- Don't edit env files, ask the user to do this for you.
- Don't look in archived files, they are assumed to be irrelevant.
- Don't edit anything under the private-docs dir.


## Specs

The compiler's stages are:

<1. original source, e.g. typescript> -->
<2. ir> --> <3. target low-level, e.g. asm, wasm, machine code> --> <4. binary>


1 --> 2  requires LLM generation
2 --> 3  requires compiler lowering


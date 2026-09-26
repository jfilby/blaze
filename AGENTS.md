# Instructions

## Project

This is Blaze, an AI compiler to generate assembly from traditional source.


## Layout

`src/compiler` is the npm package: manifest, lockfile, tsconfig, sources and
tests all live there. Run commands from it.
- `npm run typecheck`, `npm test`, `npm run aic -- <args>`


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


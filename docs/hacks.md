# Hacks

An honest inventory of the compromises the compiler is built on. These are not
bugs: each one works, is documented where it is used, and was chosen because the
alternative was larger. They are collected here so the cost of each is visible
in one place, and so nobody mistakes them for principles.

## The self-hosting story is scaffolding

- `src/compiler/ai/review-native.ts:19-21` throws for every provider: the first
  fixed point uses `--model replay`, and the native adapter refuses anything
  that would need the network.
- `src/compiler/ai/backend.ts:295` —
  `entries[Math.min(sequence - 1, entries.length - 1)]` silently reuses the last
  recorded answer when a build asks for more reviews than the replay file
  holds, which can make a broken review loop look sound.
- `src/compiler/core/platform-native.ts:109-115` — `freezeValue` is a documented
  no-op in the compiled binary, so immutability is weaker in the self-hosted
  build than in the Node one. "The same source, the same answer" is not quite
  true at the host boundary.
- `src/compiler/test/self-host.test.ts` — progress is a hand-maintained
  `REFUSAL_BUDGET = 0` preceded by a long prose changelog of past values. The
  count once measured how far a parse got rather than what was missing, and it
  still rises and falls depending on which parser reads a body.

Until the native build can talk to a model, the fixed-point machinery is a
measurement harness rather than a working self-hosted compiler.

## Heuristics that decide correctness-adjacent outcomes

- `src/compiler/semantics/restructure.ts:72-94` — `CALL_COST = 12`,
  `UNKNOWN_TURNS = 8`, `MAX_ASSUMED_TURNS = 64`. Whether a call is fused out of a
  loop, and therefore whether a build succeeds, depends on unsourced constants:
  "eight is the middle: enough that a call inside an unknown loop is worth
  removing… nobody is fusing a call out of a loop that runs a billion times."
- `src/compiler/offline-build.ts:145-153` — a validator given no callees measures
  a call as a call and refuses a loop the optimizer admitted, so passes must be
  re-fed each other's inputs or the build fails on a verdict nothing changed.
- `src/compiler/compiler.ts:261-268` — `PROGRAM_REPAIR_ROUNDS = 2`, "deliberately
  small: the loop is for a program that is one mistake away from agreeing."
- `src/compiler/core/types.ts:537` and
  `src/compiler/toolchain/verifier.ts:91-99` — "randomized" verification uses a
  fixed seed `0x5eed1234`, so it is deterministic by construction.

## Not a hack

`private lie(held)` in `src/compiler/toolchain/ir-wasm.ts:1357-1368` sounds like
one, but it is just a pun for "falsity": `i64.eqz` for a 64-bit whole, `f64.eq`
against zero for a float. Likewise `coerce` in
`src/compiler/semantics/ir-resolve.ts` is an ordinary diagnostic helper.

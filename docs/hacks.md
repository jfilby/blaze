# Hacks

An honest inventory of the compromises the compiler is built on. These are not
bugs: each one works, is documented where it is used, and was chosen because the
alternative was larger. They are collected here so the cost of each is visible
in one place, and so nobody mistakes them for principles.

## The biggest hack: every value is a double, and ≥4096 means pointer

The C backend's dynamic side has a single untagged 64-bit slot. Everything —
numbers, registry indices, texts, records — travels as an IEEE-754 `double`.
The runtime recovers meaning from the numeric range of the value and by reading
a magic word *before* the address:

- `src/compiler/runtime/abi.ts:7963-7967` — `blaze_rt_is_block`:
  `return value > 4096.0 && value < 281474976710656.0;` — justified as "a handle
  of the dynamic registry is a small index, and no allocation is at an address
  below a page."
- `src/compiler/runtime/abi.ts:6290-6291` — `blaze_rt_to_text`:
  `if (value >= 4096.0) return (const char*)(uintptr_t)value;` — the comment
  says "when it points at readable memory", but no such check exists.
- `src/compiler/runtime/abi.ts:4356-4368` — a managed string carries its length
  in a header 48 bytes in front of it. A C literal has no header, so the runtime
  reads 8 bytes before the pointer anyway and uses a magic word to tell the two
  apart.
- `src/compiler/runtime/abi.ts:6130-6134, 6165` — every 64 KB pool chunk wastes
  its first 64 bytes (`BLAZE_RT_DYN_POOL_GUARD`) so that the out-of-bounds-looking
  header read always lands in mapped memory. A `danger` build drops even that
  guard.
- `src/compiler/runtime/abi.ts:3771-3776` — "the IR holds no length for an
  element access and no backend emits a check for one, so the magic number, the
  overflow check and the caps are what stand between a released pointer and a
  second use of it." Bounds safety is delegated to a magic number.

Three value spaces collide in one slot: small doubles (numbers), small integers
(indices into `blaze_dyn_reg`), and raw pointers cast through 74
`(double)(uintptr_t)` expressions across `runtime/abi.ts`, `toolchain/driver.ts`
and `toolchain/ir-c.ts`. The consequences leak into unrelated features:

- SQLite handles must be slot indices, because "the runtime renders a value it
  does not hold and that is above 4096 as if it were a string pointer"
  (`src/compiler/runtime/sqlite-build.ts:105-114`).
- Module globals live in a fixed `blaze_rt_globals[4096]` array whose
  out-of-range indices silently clamp to slot 0
  (`src/compiler/runtime/abi.ts:4423-4427`).
- The magic constant `0x424C415A45525400` is hand-copied into C, Nim and the
  wasm host, which must agree byte-for-byte.

Replacing this would mean redesigning the language's value model, not patching a
function.

## Global slots discovered by regex over literal text

`src/compiler/semantics/program.ts:473-551` hard-codes four call names
(`blaze_rt_global_get`, `_set`, `_post_inc`, `_post_dec`), matches `/^[0-9]+$/`
against a decimal string literal in an untyped tree walk, finds the highest slot
per file, and rewrites those literal strings to shift each file past the
previous one. A global cell is not a first-class IR value; it is a naming
convention the contract phase has to know about. Correctness rests on the exact
literal shape the frontend emitted, and the scheme shares the runtime's 4096-slot
ceiling — where an out-of-range index aliases slot 0 without complaint.

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

## WebAssembly memory by decree

- `src/compiler/toolchain/ir-wasm.ts:452-477` — `WIDE_DATA_BASE = 4096` ("a page
  is 65536 bytes and the import asks the host for one, so everything below this
  is addressable whatever the host allocated") and `SCRATCH_LIMIT = 65536`.
- `src/compiler/toolchain/wasm-host-runtime.ts:1078-1086` — the host starts its
  cursor at `65536` and must import exactly one page for the convention to hold.
- `docs/specs/wasm.md:282-288` — the module is lowered twice: once to discover
  its imports and scratch needs, once to write calls at the resulting indexes.
  This relies on "the same lowering over the same input" agreeing both times.

Two modules must agree on hard-coded numbers with no shared declaration, and a
deferred, duplicated computation is held together by convention rather than by
structure.

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

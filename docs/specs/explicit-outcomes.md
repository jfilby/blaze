# Explicit contracts for correctness-adjacent decisions

A build must never succeed or fail because two passes used different
assumptions, or because an arbitrary iteration limit was reached. Profitability
may be a heuristic; safety, convergence and verification are not. This spec
records the four contracts that replaced the old correctness-adjacent
heuristics and the shared outcome type they speak in.

## Outcomes

`src/compiler/core/outcome.ts` defines the vocabulary every pass uses:

```
CompilerOutcome =
  | { status: "passed" }
  | { status: "failed"; errors: Diagnostic[] }
  | { status: "incomplete"; reason: string }
```

`Assessment<T>` is `known | unknown | incomplete`: a measured value, a missing
input, or an unbounded question. A diagnostic names the pass that produced it
and, when one was needed, the assumption it relied on. Unknown and incomplete
are never failures, and a retry limit is never a proof.

## Fusion safety is proved, profitability is priced

`src/compiler/semantics/restructure.ts` no longer decides safety from a cost.
`fusionSafety` proves a call may be fused from semantic properties: no effects,
no allocation, no printing, no command-line reads, an owned return, a body a
splice can hold, no recursion into itself or its caller, and only calls the
caller may name. If any of that cannot be shown, the call stays in place.

Loop activity is structural: a counted loop with readable ends has an exact
turn count; every other loop is `repeated`, hot by structure and carrying no
assumed number of turns. `UNKNOWN_TURNS` and `MAX_ASSUMED_TURNS` are gone.

The deterministic loop-invariant pass deliberately never moves a call: it
requires a bindable value with no call in it, because moving a call changes
when it is evaluated and only a proof can license that. The cross-boundary
rewrite is fusion, and it is fusion that the old constants made depend on an
assumed turn count. Both passes now share the rule that a call is left in place
unless its safety is proved; profitability never enters that decision.

`src/compiler/semantics/cost-model.ts` holds the one `CostModel`. Its weights
price calls, operations, memory writes, branches and unknown loops for
*profitability only*; no weight can change whether a rewrite is safe. An
unresolved call resolves to an explicit `unknown` assessment instead of a
silently assumed price.

## Optimizer and validator read one context

`src/compiler/semantics/semantic-context.ts` carries the callee bodies and the
cost model in one value. `offline-build.ts` builds one context and hands it to
both the optimizer and the validator, so they price the same program with the
same information. The validator's verdict is an explicit `CompilerOutcome` via
`semanticFunctionOutcome`: a gap in callee information is `incomplete`, not a
contradiction. This replaces the old comment that re-fed callee maps by hand to
keep the two passes agreeing.

In `src/compiler/semantics/parallel.ts`, `turnCostAssessment` reports a turn's
cost as `known`, `unknown` (a callee body is absent), or `incomplete` (a
recursive call has no bound). `measureCall` records unresolved calls explicitly
rather than charging a bare call. The boolean `turnIsTooCheap` remains only as
the conservative lower bound a backend uses when it has no callee bodies.

## Repair converges on program state

`src/compiler/semantics/repair-convergence.ts` replaces
`PROGRAM_REPAIR_ROUNDS`. Each round either verifies, produces a program state
not seen before, or stops. A repeated state is a fixed point (the previous one)
or a cycle (an earlier one). `maxRepairRounds` (also `[generation]` in a project
file) is a configurable resource budget; exhausting it reports `incomplete`,
never a successful build and never a claim that the program is irreparable.
The default of three rounds preserves the historical build. The fingerprint is
the selected implementation of every unit plus the shape of the disagreement,
sorted by unit name so it is deterministic.

## Verification is random unless a seed is given

`DEFAULT_TEST` no longer carries a seed. `resolveVerificationSeed` draws a
fresh 32-bit seed by folding a `randomUUID()` (a CSPRNG-backed host service)
with FNV-1a when the project gives none, and honours an explicit `test.seed`
for reproducibility. The seed is recorded on every `VerificationResult`.

`test.batches` (default 1) plans independent randomized batches. With an
explicit seed batch `i` uses `seed + i`, so a whole run reproduces while its
batches still differ; without one each batch draws its own secure seed.
`VerificationResult` records the run seed, every batch's seed and counts, and
`deterministicPassed` separately from `randomPassed`, and carries a `status` of
`passed`, `failed` or `incomplete`.

The demo vector uses a fixed structural seed of its own: it is a deterministic
regression example and must not draw from the per-run verification randomness.

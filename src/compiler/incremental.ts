/**
 * Incremental compilation.
 *
 * A build reuses what an earlier build already proved. What makes a stored
 * implementation reusable is a key over everything that determines it: the
 * contract of the function itself, the ABI of every other function of the
 * program, the target, the output and runtime kinds, the test and benchmark
 * configuration, the model, the compiler version, and a hash of the compiler's
 * own sources. A key that still matches means the stored object was built from
 * exactly the same inputs, so it is linked again as it stands rather than
 * resolved, assembled and verified once more.
 *
 * A key covers the ABI of the other functions rather than their whole
 * contracts, because an object only depends on what it is linked against: a
 * callee whose body changed is regenerated, and the caller that calls its
 * symbol is not. A signature or an object layout is part of the ABI, so a
 * change to either does invalidate the caller, which is the one change that
 * can break an object that is not rebuilt.
 *
 * A callee whose body this one writes out rather than calls is the exception,
 * and the key follows the outline's decision: that body would be inside this
 * object, so its whole definition is part of the key rather than its ABI
 * alone. Without that, a fix to a callee would rebuild the callee and leave
 * every caller keyed against the body it was given before the fix.
 *
 * The record is one file that a build adds each function to as soon as that
 * function is verified, so a build that fails on a later function still leaves
 * the earlier ones reusable. Reuse is therefore per function and survives
 * failure, which is the whole point: a build that has to redo one function
 * should not redo the rest. A build that reviews several functions at a time
 * writes it through one lock, so two functions finishing together cannot each
 * read the record before the other wrote it and lose an entry between them.
 */

import { hashValue, type JsonStore } from "./core/json-store.ts";
import { contractsByName, writtenOut } from "./semantics/calls.ts";
import type { TestVector } from "./toolchain/verifier.ts";
import type {
  Candidate,
  BackendKind,
  BuildMode,
  BenchmarkConfig,
  CandidateOutcome,
  FunctionContract,
  OutputKind,
  ProgramContract,
  RuntimeKind,
  TargetSpec,
  TestConfig,
} from "./core/types.ts";

/** What a stored function was built from, and what it produced. */
export interface IncrementalEntry {
  /**
   * sha256 of everything the *review* depends on: the inputs, and every source
   * that decides what the IR is or what a model said about it.
   */
  reviewKey: string;
  /**
   * sha256 of the review key and the sources that decide what the IR is
   * lowered into, so a match on this one is a match on the other by
   * construction: an object is only relinked when the review that chose it
   * still holds.
   */
  objectKey: string;
  /** The file that declares the function, as the contract names it. */
  file: string;
  /** The candidate the build selected, and the only one that may be reused. */
  selected: string;
  candidates: Candidate[];
  /** The outcomes of those candidates, so a reuse reports what it relied on. */
  outcomes: CandidateOutcome[];
  /** The vector the benchmark ran, or null for a contract that returns nothing. */
  benchmarkVector: TestVector | null;
}

/** What a previous build left behind, by function name. */
export type IncrementalRecord = Record<string, IncrementalEntry>;

/**
 * How much of a stored implementation a build may reuse. `object` is the whole
 * artifact: it is linked as it stands and is not verified again. `assembly` is
 * the source of it: the toolchain rebuilds and re-verifies it, and only asks a
 * model if that fails.
 */
export type ReuseLevel = "object" | "assembly";

export interface UnitKeyInput {
  contract: FunctionContract;
  file: string;
  program: ProgramContract;
  target: TargetSpec;
  output: OutputKind;
  mode: BuildMode;
  backend: BackendKind;
  runtime: RuntimeKind;
  test: TestConfig;
  benchmark: BenchmarkConfig;
  /** The model the artifact was reviewed by, or `compiler` when none was. */
  model: string;
  compilerVersion: string;
  /**
   * The hashes of the compiler's own sources, split by what each decides. The
   * prompt, the resolver, the optimizer and the rules that decide whether a
   * candidate is valid are named by neither a contract nor a target and decide
   * the review, so `review` is over them. The assembler, the encoder and the
   * runtime decide the object and nothing that came before it, so `lowering` is
   * over those, and a build that edited one of them can still reuse the
   * candidates an earlier build reviewed.
   */
  review: string;
  /** The sources that decide what the IR is lowered into. */
  lowering: string;
}

/**
 * The two keys of one compiled function.
 *
 * `review` answers whether what a model said still holds, and `object` whether
 * what the toolchain built from it is still the toolchain's to link. They are
 * one key and a second key over the first, so agreeing on the second is
 * agreeing on the first.
 */
export interface UnitKeys {
  readonly review: string;
  readonly object: string;
}

/**
 * What another function of the program contributes to this one: the ABI of a
 * function this one calls, and the body of a function this one writes out.
 *
 * A call is a symbol, so a callee's implementation cannot change what the
 * caller's object does and only its signature and object layouts matter. A
 * body written out is the opposite: the text of the callee is inside the
 * caller's object, so a callee whose body changes leaves a stored caller
 * holding the old one, and the caller has to be regenerated. That is the whole
 * reason the strategy is read here rather than treated as a note on the graph.
 */
function abiOf(contract: FunctionContract, holdsTheBody: boolean): unknown {
  const abi = { function: contract.function, objects: contract.definition.objects };
  return holdsTheBody ? { ...abi, definition: contract.definition } : abi;
}

/**
 * The keys of one compiled function. Two builds that agree on the review key
 * can share the candidates a model produced and the verdicts recorded against
 * them, and two that also agree on the object key can share the object itself.
 */
export function unitKeys(input: UnitKeyInput): UnitKeys {
  const own = input.contract.function.name;
  // The whole closure, not the direct callees: a body written out carries the
  // calls it made, so what ends up inside this object is everything below it.
  const written = new Set(
    writtenOut(contractsByName(input.program.files), input.contract)
      .map((contract) => contract.function.name)
      .filter((name) => name !== own),
  );
  const others = input.program.files
    .flatMap((file) => Object.entries(file.functions))
    .filter(([name]) => name !== own)
    .map(([name, contract]): readonly [string, unknown] => [name, abiOf(contract, written.has(name))])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const review = hashValue({
    contract: input.contract,
    abi: others,
    file: input.file,
    target: input.target,
    backend: input.backend,
    mode: input.mode,
    output: input.output,
    runtime: input.runtime,
    test: input.test,
    benchmark: input.benchmark,
    model: input.model,
    compilerVersion: input.compilerVersion,
    toolchain: input.review,
  });
  return { review, object: hashValue({ review, lowering: input.lowering }) };
}

/**
 * How much of a stored entry a build may reuse, or null for none of it.
 *
 * The two levels answer two questions. `object` is the whole artifact: it is
 * linked as it stands and is not verified again, which needs the object key to
 * match, because an object built by an assembler this build no longer has is
 * not this build's to link. `assembly` is the source of it: the candidates are
 * taken as they stand and put through the toolchain as it is now, which is
 * what an edit to the lowering is for, and needs only the review key to match.
 * Every level needs the review to match, and only the selected candidate counts,
 * and only when the record says it was valid: an entry is written when a
 * function is verified, so a stored entry is a stored proof, and a build that
 * trusts a candidate the toolchain rejected would be trusting a failure.
 */
export function reusable(
  entry: IncrementalEntry | undefined,
  keys: UnitKeys,
  objectBuilt: boolean,
): ReuseLevel | null {
  if (entry === undefined || entry.reviewKey !== keys.review || entry.selected === "") return null;
  const outcome = entry.outcomes.find((candidate) => candidate.candidate === entry.selected);
  if (outcome === undefined || !outcome.valid) return null;
  return objectBuilt && entry.objectKey === keys.object ? "object" : "assembly";
}

/**
 * The stored record of a project. A record that is not the shape this reads is
 * no record at all: a cache that cannot be parsed is a build that generates,
 * never a build that fails. A record that cannot be read at all is a fault and
 * is raised, because a build that took it for absent would write over it.
 */
export async function readIncremental(store: JsonStore, path: string): Promise<IncrementalRecord> {
  const value = await store.readIfValid<unknown>(path);
  // The record is keyed by whatever the source named its functions, and
  // `__proto__` is a legal name. On an object with the usual prototype,
  // assigning to that key is not an assignment at all: it is the inherited
  // setter, and it replaces the prototype instead of adding an entry, so the
  // stored implementation is dropped on the way in and never read on the way
  // out. A record with no prototype has no such setter. That is true of a
  // record read from disk and of the empty one alike, and the empty one is the
  // one a project's first build gets, so it is built the same way rather than
  // returned as a `{}`.
  const record = Object.create(null) as IncrementalRecord;
  if (value === undefined || typeof value !== "object" || value === null) return record;
  for (const [functionName, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<IncrementalEntry>;
    if (
      typeof candidate.reviewKey !== "string" ||
      typeof candidate.objectKey !== "string" ||
      typeof candidate.file !== "string" ||
      typeof candidate.selected !== "string" ||
      !Array.isArray(candidate.candidates) ||
      !Array.isArray(candidate.outcomes)
    ) {
      continue;
    }
    record[functionName] = {
      reviewKey: candidate.reviewKey,
      objectKey: candidate.objectKey,
      file: candidate.file,
      selected: candidate.selected,
      candidates: candidate.candidates as Candidate[],
      outcomes: candidate.outcomes as CandidateOutcome[],
      benchmarkVector: (candidate.benchmarkVector ?? null) as TestVector | null,
    };
  }
  return record;
}

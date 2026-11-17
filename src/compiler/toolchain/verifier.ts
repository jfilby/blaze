/**
 * Verification.
 *
 * A candidate is valid only if it reproduces the semantics of the contract.
 * The reference implementation is the contract itself: the result definition
 * is evaluated by the compiler for every test vector, and the candidate's
 * result is compared against it.
 *
 * Test vectors cover fixed examples, boundary lengths and randomized cases.
 * Every vector must satisfy the contract's preconditions, and every postcondition
 * is checked on the candidate's own result.
 */

import {
  comparisonTolerance,
  evaluate,
  isBufferType,
  isFloatType,
  isIntegerType,
  parseType,
  bufferElement,
  preconditionFailures,
  referenceResult,
  valuesMatch,
  type Expr,
  type ParsedContract,
  type Value,
} from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { monotonicTimeNs, randomUUID } from "../core/platform.ts";
import { byName } from "../core/named-record.ts";
import { run, GENERATED_HEAP_BYTES } from "../core/process.ts";
import type { FunctionContract, Runner, TestConfig, TestFailure, TypeExpr, VerificationBatch, VerificationResult } from "../core/types.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

const BOUNDARY_LENGTHS = [0, 1, 2, 3, 4, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 257, 1023, 1024];

export interface TestVector {
  id: string;
  kind: "fixed" | "boundary" | "random";
  /** Argument values in harness protocol form: text per element, or null. */
  args: Record<string, string | string[] | null>;
}

function verificationError(message: string, detail: string | undefined, functionName: string, candidate?: string): CompilerError {
  return new CompilerError("VerificationError", "verify", message, detail, functionName, candidate, "");
}

type ScalarValue = number | bigint | boolean;
type ScalarType = { kind: string; name?: string };

function formatScalar(type: ScalarType, value: ScalarValue): string {
  if (type.name === "bool") return value === true || value === 1n ? "1" : "0";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "bigint") return value.toString();
  // JavaScript prints the shortest decimal that reads back as the same double,
  // and strtod/strtof round it to the same value, so the transfer is exact.
  if (isFloatType(type.name as never)) return String(type.name === "f32" ? Math.fround(value) : value);
  return Math.trunc(value).toString();
}

function parseScalar(type: ScalarType, text: string): Value {
  if (type.name === "bool") return text === "1" || text === "true";
  if (isFloatType(type.name as never)) {
    const parsed = parseFloatingText(text);
    return type.name === "f32" ? Math.fround(parsed) : parsed;
  }
  return BigInt(text);
}

/** Reads the textual floats the harness produces, including inf and nan. */
function parseFloatingText(text: string): number {
  const lowered = text.toLowerCase();
  if (lowered === "inf" || lowered === "+inf" || lowered === "infinity") return 1 / 0;
  if (lowered === "-inf" || lowered === "-infinity") return -1 / 0;
  if (lowered === "nan" || lowered === "-nan") return 0 / 0;
  const parsed = Number(text);
  if (Number.isNaN(parsed)) {
    throw new CompilerError("VerificationError", "verify", `the candidate printed "${text}", which is not a number`, "", "", "", "");
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Test vector generation                                                     */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed a verification run uses. An explicit seed is honoured for
 * reproducibility; otherwise a fresh seed is drawn from the host's
 * cryptographically secure source, so two independent runs explore different
 * inputs. A UUID is 122 bits of CSPRNG output, folded into the 32-bit seed the
 * PRNG takes with an FNV-1a hash — no time or counter is trusted for
 * randomness, and no radix parser is needed.
 */
export function resolveVerificationSeed(config: TestConfig): { seed: number; explicit: boolean } {
  const given = config.seed;
  if (given !== undefined) {
    return { seed: Number(given) >>> 0, explicit: true };
  }
  const uuid = randomUUID().replace(/-/g, "");
  let seed = 2166136261;
  for (let index = 0; index < uuid.length; index += 1) {
    seed = Math.imul(seed ^ uuid.charCodeAt(index), 16777619) >>> 0;
  }
  return { seed, explicit: false };
}

/** One independently seeded batch of vectors for a verification run. */
export interface VerificationBatchPlan {
  readonly seed: number;
  readonly vectors: TestVector[];
}

/**
 * Plans one or more independent randomized batches.
 *
 * With an explicit seed, batch `i` uses `seed + i`, so a whole run is
 * reproducible while its batches still differ from each other. With no
 * explicit seed, each batch draws its own secure seed. The first batch's
 * vectors are exactly those `planTestVectors` would produce for the same
 * config, so existing single-batch callers keep their behaviour.
 */
export function planVerificationBatches(parsed: ParsedContract, config: TestConfig): VerificationBatchPlan[] {
  const count = Math.max(1, Math.floor(Number(config.batches ?? 1)));
  const plans: VerificationBatchPlan[] = [];
  for (let index = 0; index < count; index += 1) {
    const seed = config.seed === undefined
      ? resolveVerificationSeed(config).seed
      : (Number(config.seed) >>> 0) + index;
    plans.push({ seed, vectors: planTestVectors(parsed, config, seed) });
  }
  return plans;
}

/** Identifiers that determine how much of a buffer is read. */
function lengthParameters(parsed: ParsedContract): string[] {
  const names = new Set<string>();
  const contract = fieldOf(parsed, "contract") as FunctionContract;
  const memory = fieldOf(contract, "memory") as { readonly reads: readonly string[]; readonly writes: readonly string[] };
  const ranges: string[] = [];
  for (const one of fieldOf(memory, "reads") as readonly string[]) ranges[ranges.length] = one;
  for (const one of fieldOf(memory, "writes") as readonly string[]) ranges[ranges.length] = one;
  for (const range of ranges) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*\[([^:]+):(.+)\]$/.exec(range.trim());
    if (match === null) continue;
    const otherBounds = [match[2], match[1]];
    for (let bi = 0; bi < 2; bi++) {
      const bound = [match[1], match[2]][bi];
      const other = otherBounds[bi];
      const trimmed = bound.trim();
      // A bound that is a single identifier names a length the vector settles
      // on the buffer's size, unless that same identifier also appears in the
      // other bound's expression: then it is an index (such as `i` in
      // `a[i:i+1]`), and the vector gives it an ordinary value instead.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) continue;
      const identifier = trimmed;
      if (new RegExp(`\\b${identifier}\\b`).test(other)) continue;
      const env = fieldOf(parsed, "env") as ReadonlyMap<string, TypeExpr>;
      const type = env.get(identifier);
      if (type === undefined) continue;
      // A buffer is not a count. The bound `len(a)` is the length of the
      // buffer `a`, and the vector gives a buffer a length of its own: a
      // vector that gave the buffer a count would read the count as the
      // buffer, and the precondition the range states would be checked
      // against a number.
      if (isBufferType(type)) continue;
      names.add(identifier);
    }
  }
  return [...names];
}

function isSignedName(name: string | undefined): boolean {
  return name === "isize" || (name !== undefined && name.startsWith("i"));
}

/** The smallest and the largest value each whole type holds. */
const INTEGER_RANGE: Record<string, readonly [bigint, bigint]> = {
  i8: [-128n, 127n],
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
  isize: [-9223372036854775808n, 9223372036854775807n],
  u8: [0n, 255n],
  u16: [0n, 65535n],
  u32: [0n, 4294967295n],
  u64: [0n, 18446744073709551615n],
  usize: [0n, 18446744073709551615n],
  u256: [0n, (1n << 256n) - 1n],
  i256: [-(1n << 255n), (1n << 255n) - 1n],
};

/**
 * A whole number drawn across the whole range of its type. A draw below 2^53
 * is taken directly; a wider range is covered by 64 random bits, so the top of
 * a 64 bit type is as reachable as the bottom.
 */
function randomWhole(random: () => number, low: bigint, high: bigint): bigint {
  const span = high - low + 1n;
  if (span <= BigInt(Number.MAX_SAFE_INTEGER)) return low + BigInt(Math.floor(random() * Number(span)));
  const half = 0x1_0000_0000n;
  const bits = BigInt.asUintN(64, (BigInt(Math.floor(random() * Number(half))) << 32n) | BigInt(Math.floor(random() * Number(half))));
  return low + (bits % span);
}

function randomScalar(random: () => number, type: ScalarType): ScalarValue {
  if (type.name === "bool") return random() < 0.5;
  if (isFloatType(type.name as never)) {
    const signed = (random() - 0.5) * (1 + Math.floor(random() * 64));
    const value = type.name === "f32" ? Math.fround(signed) : signed;
    return random() < 0.2 ? 0 : value;
  }
  if (type.kind === "primitive" && isIntegerType(type.name as never)) {
    const [low, high] = INTEGER_RANGE[type.name as string];
    const choice = random();
    if (choice < 0.1) return 0n;
    if (choice < 0.2) return BigInt(1 + Math.floor(random() * 4));
    // The everyday values stay everyday, so a plan is still readable, but
    // they are not the only ones: a candidate whose arithmetic does not wrap
    // at the width of the type agrees with the contract over every other
    // value and disagrees on these. They are also brought inside the type,
    // because -32 is not a value a `u256` holds and the reference would
    // compare the signed number the vector names while the kernel compares
    // the four limbs the candidate was handed — the two answers differ
    // wherever the wrap crosses zero, which is nearly everywhere.
    if (choice < 0.45) {
      const everyday = BigInt(Math.floor(random() * 66)) - 32n;
      return everyday < low ? low : everyday > high ? high : everyday;
    }
    if (choice < 0.6) {
      const edges = [low, high, low + 1n, high - 1n, low + 2n, high - 2n];
      return edges[Math.floor(random() * edges.length)];
    }
    return randomWhole(random, low, high);
  }
  throw new CompilerError("VerificationError", "verify", `cannot generate test values of type ${String(type.name)}`, "", "", "", "");
}

function patternValue(kind: "zeros" | "ones" | "ramp" | "alternating", index: number): number {
  const word = String(kind);
  if (/^zeros$/.test(word)) return 0;
  if (/^ones$/.test(word)) return 1;
  if (/^ramp$/.test(word)) return index % 17;
  return index % 2 === 0 ? 1 : -1;
}

interface VectorBuilder {
  id: string;
  kind: TestVector["kind"];
  length: number;
  pattern: "random" | "zeros" | "ones" | "ramp" | "alternating";
  random: () => number;
}

function buildVector(parsed: ParsedContract, builder: VectorBuilder, lengthParameters: readonly string[], indexParameters: ReadonlySet<string> = new Set()): TestVector {
  // Keyed by whatever the source called the parameter, so this is built from
  // entries: a parameter called `__proto__` would otherwise set the prototype
  // of the record instead of adding an argument, and the vector would reach
  // the harness with one argument short.
  const args: (readonly [string, string | string[] | null])[] = [];
  const paramList = fieldOf(fieldOf(fieldOf(parsed, "contract"), "function"), "params") as readonly { readonly name: string; readonly type: string }[];
  for (const param of paramList) {
    const paramName = String(fieldOf(param, "name"));
    const type = parseType(String(fieldOf(param, "type")));
    if (lengthParameters.includes(paramName)) {
      args.push([paramName, formatScalar(type, BigInt(Number(fieldOf(builder, "length"))))]);
      continue;
    }
    if (type.kind === "text") {
      // A text parameter is one word of the header line, and it is the value
      // itself: a text is not a buffer, so it has no data line to follow it.
      // The vector is generated, so the word it carries is generated too.
      args.push([paramName, `arg${args.length}`]);
      continue;
    }
    if (type.kind !== "primitive") {
      const element = bufferElement(type);
      const size = type.kind === "array" && type.length !== null ? type.length : Number(fieldOf(builder, "length"));
      args.push([paramName, Array.from({ length: size }, (_, index) => formatScalar(element, scalarFor(builder, element, index)))]);
      continue;
    }
    if (indexParameters.has(paramName) && (type.kind === "primitive" && isIntegerType(type.name as never))) {
      // An index stays inside the buffer it reads: a value at most the
      // buffer's length, so the precondition that guards the access holds.
      const maxIndex = Math.max(0, Number(fieldOf(builder, "length")) - 1);
      const value = Math.floor((fieldOf(builder, "random") as (value: unknown) => number)(undefined) * (maxIndex + 1));
      args.push([paramName, formatScalar(type, BigInt(value))]);
      continue;
    }
    args.push([paramName, formatScalar(type, randomScalar(builder.random, type))]);
  }
  return { id: String(fieldOf(builder, "id")), kind: fieldOf(builder, "kind") as TestVector["kind"], args: byName(args) };
}

function scalarFor(builder: VectorBuilder, type: ScalarType, index: number): ScalarValue {
  const pattern = fieldOf(builder, "pattern") as "random" | "zeros" | "ones" | "ramp" | "alternating";
  if (/^bool$/.test(String(type.name))) {
    if (/^ones$/.test(String(pattern))) return true;
    const pick = (fieldOf(builder, "random") as (value: unknown) => number)(undefined);
    if (pick < 0.5) return true;
    return false;
  }
  if (!/^random$/.test(String(pattern))) {
    const raw = patternValue(pattern as "zeros" | "ones" | "ramp" | "alternating", index);
    const value = isSignedName(type.name) ? raw : Math.abs(raw);
    if (isFloatType(type.name as never)) {
      return /^f32$/.test(String(type.name)) ? Math.fround(value) : value;
    }
    return BigInt(value);
  }
  return randomScalar(builder.random, type);
}

/** One seeded generator, held as a field so a call reaches it by name. */
class RandomSource {
  next: (value: unknown) => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
}

/** The next number of a seeded generator. */
function nextRandom(source: RandomSource): number {
  return (fieldOf(source, "next") as (value: unknown) => number)(undefined);
}

/** Fixed, boundary and randomized vectors, filtered by the preconditions. */
export function planTestVectors(parsed: ParsedContract, config: TestConfig, seed?: number): TestVector[] {
  const lengths = lengthParameters(parsed);
  const contract = fieldOf(parsed, "contract") as FunctionContract;
  const memory = fieldOf(contract, "memory") as { readonly reads: readonly string[]; readonly writes: readonly string[] };
  const env = fieldOf(parsed, "env") as ReadonlyMap<string, TypeExpr>;
  // Parameters that appear inside a memory range's bounds are indices into a
  // buffer, not counts: they are generated within the buffer's length so the
  // precondition that guards the access can hold, instead of spanning the
  // whole integer type and overflowing the arithmetic the contract wraps.
  const indexParams = new Set<string>();
  const ranges: string[] = [];
  for (const one of fieldOf(memory, "reads") as readonly string[]) ranges[ranges.length] = one;
  for (const one of fieldOf(memory, "writes") as readonly string[]) ranges[ranges.length] = one;
  for (const range of ranges) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*\[([^:]+):(.+)\]$/.exec(range.trim());
    if (match === null) continue;
    for (const bound of [match[1], match[2]]) {
      for (const identifier of bound.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        const type = env.get(identifier);
        if (type === undefined || isBufferType(type)) continue;
        indexParams.add(identifier);
      }
    }
  }
  const chosenSeed = seed ?? resolveVerificationSeed(config).seed;
  const source = new RandomSource(chosenSeed);
  const makeRandom = (): number => nextRandom(source);
  const maxLength = Math.max(1, Number(fieldOf(config, "maxLength")));

  const builders: VectorBuilder[] = [
    { id: "zeros", kind: "fixed", length: 1, pattern: "zeros", random: makeRandom },
    { id: "zeros-17", kind: "fixed", length: 17, pattern: "zeros", random: makeRandom },
    { id: "ones-1", kind: "fixed", length: 1, pattern: "ones", random: makeRandom },
    { id: "ones-8", kind: "fixed", length: 8, pattern: "ones", random: makeRandom },
    { id: "ramp-13", kind: "fixed", length: 13, pattern: "ramp", random: makeRandom },
    { id: "alternating-32", kind: "fixed", length: 32, pattern: "alternating", random: makeRandom },
  ];
  for (const length of BOUNDARY_LENGTHS) {
    if (length > maxLength) continue;
    builders.push({ id: `boundary-${length}`, kind: "boundary", length, pattern: "random", random: makeRandom });
  }
  for (let index = 0; index < Math.max(0, Number(fieldOf(config, "randomCases"))); index += 1) {
    builders.push({
      id: `random-${index}`,
      kind: "random",
      length: Math.floor(nextRandom(source) * (maxLength + 1)),
      pattern: "random",
      random: makeRandom,
    });
  }

  const vectors: TestVector[] = [];
  for (const builder of builders) {
    const vector = buildVector(parsed, builder, lengths, indexParams);
    const violations = preconditionFailures(parsed, vectorValues(contract, vector));
    if (violations.length > 0) continue;
    vectors.push(vector);
  }

  if (vectors.length === 0) {
    // Fall back to a vector whose scalar parameters are all zero and whose
    // buffers have the smallest non-empty length: a precondition that ties a
    // scalar to a buffer's length is most likely to hold for the smallest
    // inputs, and a function whose domain excludes them is not checkable by
    // vectors at all.
    const fallbackBuilder: VectorBuilder = { id: "fallback-0", kind: "fixed", length: 1, pattern: "zeros", random: makeRandom };
    const fallback = buildVector(parsed, fallbackBuilder, lengths, indexParams);
    if (preconditionFailures(parsed, vectorValues(contract, fallback)).length === 0) {
      vectors.push(fallback);
    }
  }
  if (vectors.length === 0) {
    throw verificationError(
      `no test vector satisfies the preconditions of ${String(fieldOf(fieldOf(contract, "function"), "name"))}`,
      (fieldOf(contract, "requires") as readonly string[]).join("; "),
      String(fieldOf(fieldOf(contract, "function"), "name")),
    );
  }
  return vectors;
}

/**
 * A fixed seed for the demo vector only. It is not a verification seed: the
 * demo is a deterministic regression example, so it must not draw from the
 * per-run secure seed that makes randomized verification explore new inputs.
 */
const DEMO_SEED = 0;

/**
 * The vector a delivered program runs when a person starts it with no piped
 * input. It is a fixed pattern rather than a random case, so the number the
 * program prints is the same on every machine, and it is the first planned
 * vector that satisfies the preconditions.
 */
export function selectDemoVector(parsed: ParsedContract, config: TestConfig): TestVector {
  const source = new RandomSource(DEMO_SEED);
  const makeRandom = (): number => nextRandom(source);
  const lengths = lengthParameters(parsed);
  const builders: VectorBuilder[] = [
    { id: "demo-8", kind: "fixed", length: 8, pattern: "ramp", random: makeRandom },
    { id: "demo-4", kind: "fixed", length: 4, pattern: "ramp", random: makeRandom },
    { id: "demo-1", kind: "fixed", length: 1, pattern: "ones", random: makeRandom },
  ];
  const contract = fieldOf(parsed, "contract") as FunctionContract;
  for (const builder of builders) {
    const vector = buildVector(parsed, builder, lengths, new Set<string>());
    if (preconditionFailures(parsed, vectorValues(contract, vector)).length === 0) return vector;
  }
  return planTestVectors(parsed, { randomCases: 0, maxLength: Number(fieldOf(config, "maxLength")) }, DEMO_SEED)[0];
}

/* -------------------------------------------------------------------------- */
/* Protocol encoding and decoding                                             */
/* -------------------------------------------------------------------------- */

export function vectorValues(contract: FunctionContract, vector: TestVector): Map<string, Value> {
  const values = new Map<string, Value>();
  const params = fieldOf(fieldOf(contract, "function"), "params") as readonly { readonly name: string; readonly type: string }[];
  const args = fieldOf(vector, "args") as Record<string, string | string[] | null>;
  for (const param of params) {
    const name = String(fieldOf(param, "name"));
    const type = parseType(String(fieldOf(param, "type")));
    const argument = args[name];
    if (type.kind === "text") {
      // A text parameter is the word itself, read back the way it was written.
      values.set(name, typeof argument === "string" ? argument : "");
      continue;
    }
    if (type.kind !== "primitive") {
      if (argument === null || argument === undefined || typeof argument === "string") {
        values.set(name, null);
        continue;
      }
      const texts = argument as readonly string[];
      const parsed: Value[] = [];
      for (const text of texts) parsed[parsed.length] = parseScalar(bufferElement(type), text);
      values.set(name, { type, values: parsed });
      continue;
    }
    values.set(name, argument === undefined ? 0 : parseScalar(type, argument as string));
  }
  return values;
}

export function encodeRunRequest(contract: FunctionContract, vectors: readonly TestVector[]): string {
  const lines = ["run"];
  for (const vector of vectors) {
    const header: string[] = [];
    const params = fieldOf(fieldOf(contract, "function"), "params") as readonly { readonly name: string; readonly type: string }[];
    const args = fieldOf(vector, "args") as Record<string, string | string[] | null>;
    for (const param of params) {
      const type = parseType(String(fieldOf(param, "type")));
      const argument = args[String(fieldOf(param, "name"))];
      header.push(
        type.kind === "primitive"
          ? String(argument)
          : type.kind === "text"
            ? String(argument)
            : argument === null || argument === undefined || typeof argument === "string"
              ? "-1"
              : String(argument.length),
      );
    }
    lines.push(header.join(" "));
    for (const param of params) {
      const type = parseType(String(fieldOf(param, "type")));
      if (type.kind === "primitive" || type.kind === "text") continue;
      const argument = args[String(fieldOf(param, "name"))];
      // An empty or null buffer has no data line, exactly like the harness
      // expects: one line per buffer that actually carries elements.
      if (argument === null || argument === undefined || typeof argument === "string" || argument.length === 0) continue;
      lines.push((argument as readonly string[]).join(" "));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function decodeRunResults(contract: FunctionContract, stdout: string, expected: number): Value[] {
  const type = parseType(String(fieldOf(fieldOf(contract, "function"), "returns")));
  const results: Value[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("RESULT ")) continue;
    // A text result is the word itself: it is read back the way it was
    // written, not parsed as the number a scalar is read as.
    if (type.kind === "text") {
      results.push(line.slice("RESULT ".length).trim());
      continue;
    }
    results.push(parseScalar(type, line.slice("RESULT ".length).trim()));
  }
  if (results.length !== expected) {
    throw verificationError(
      `the candidate produced ${results.length} results for ${expected} test vectors`,
      stdout.trim().slice(0, 400),
      String(fieldOf(fieldOf(contract, "function"), "name")),
    );
  }
  return results;
}

export function encodeBenchRequest(contract: FunctionContract, vector: TestVector, iterations: number): string {
  return encodeRunRequest(contract, [vector]).replace("run", `bench ${iterations}`);
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

function toleranceFor(parsed: ParsedContract, values: ReadonlyMap<string, Value>): number | null {
  const contract = fieldOf(parsed, "contract") as FunctionContract;
  const returns = parseType(String(fieldOf(fieldOf(contract, "function"), "returns")));
  let terms = 1;
  for (const value of values.values()) {
    const rows = fieldOf(value, "values");
    if (Array.isArray(rows)) terms = Math.max(terms, rows.length);
  }
  return comparisonTolerance(returns, terms);
}

/** Checks the postconditions against a candidate result, float tolerance included. */
function postconditionFailures(
  parsed: ParsedContract,
  values: ReadonlyMap<string, Value>,
  result: Value,
  tolerance: number | null,
): string[] {
  const failures: string[] = [];
  const bound = new Map(values);
  bound.set("result", result);

  const contract = fieldOf(parsed, "contract") as FunctionContract;
  const conditions = fieldOf(parsed, "ensures") as readonly Expr[];
  const texts = fieldOf(contract, "ensures") as readonly string[];
  conditions.forEach((condition: Expr, index: number) => {
    const text = texts[index];
    const left = fieldOf(condition, "left") as Expr;
    const conditionKind = String(fieldOf(condition, "t"));
    const leftKind = String(fieldOf(left, "t"));
    if (conditionKind === "binary" && String(fieldOf(condition, "op")) === "==" && leftKind === "var" && String(fieldOf(left, "name")) === "result") {
      const right = fieldOf(condition, "right") as Expr;
      const variant = fieldOf(parsed, "requires") as readonly Expr[];
      const expected = referenceResult({ contract: fieldOf(parsed, "contract"), env: fieldOf(parsed, "env"), requires: variant, ensures: conditions, resultDefinition: right } as ParsedContract, values);
      if (!valuesMatch(expected, result, tolerance)) {
        failures.push(`${text} (expected ${String(expected)}, got ${String(result)})`);
      }
      return;
    }
    let outcome: Value;
    try {
      outcome = evaluate(condition, { env: fieldOf(parsed, "env") as ReadonlyMap<string, TypeExpr>, values: bound });
    } catch (cause) {
      failures.push(`${text}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    if (outcome !== true) failures.push(text);
  });
  return failures;
}

export interface VerifyRequest {
  contract: FunctionContract;
  parsed: ParsedContract;
  runner: Runner;
  candidate: string;
  /** Every batch's vectors, concatenated in batch order. */
  vectors: readonly TestVector[];
  /** The seed of the run, recorded on the result. */
  seed?: number;
  /** One seed per independent randomized batch. */
  batchSeeds?: readonly number[];
  /** How many vectors each batch contributed, in batch order. */
  batchSizes?: readonly number[];
}

export function verifyCandidate(request: VerifyRequest): VerificationResult {
  const started = monotonicTimeNs();
  const contract = fieldOf(request, "contract") as FunctionContract;
  const parsed = fieldOf(request, "parsed") as ParsedContract;
  const runner = fieldOf(request, "runner") as Runner;
  const candidateName = String(fieldOf(request, "candidate"));
  const vectors = fieldOf(request, "vectors") as readonly TestVector[];
  const expected: { vector: TestVector; values: ReadonlyMap<string, Value>; result: Value | null; skip: boolean }[] = [];
  for (const vector of vectors) {
    const values = vectorValues(contract, vector);
    try {
      expected[expected.length] = { vector, values, result: referenceResult(parsed, values), skip: false };
    } catch {
      // A vector whose contract cannot be evaluated (for example, an index
      // out of bounds of a slice) is out of the function's domain: it is not
      // compared, and the candidate is not faulted for it.
      expected[expected.length] = { vector, values, result: null, skip: true };
    }
  }

  const functionName = String(fieldOf(fieldOf(contract, "function"), "name"));
  // A candidate that allocates without bound is refused by its own allocator
  // under this limit, and says so, rather than being killed by a system that
  // has run out of memory and takes the build with it.
  const execution = run(String(fieldOf(runner, "command")), fieldOf(runner, "args") as string[], {
    input: encodeRunRequest(contract, vectors),
    timeoutMs: 120_000,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  if (fieldOf(execution, "spawnError") !== undefined) {
    throw verificationError(
      `cannot run the candidate for ${functionName}`,
      String(fieldOf(execution, "spawnError")),
      functionName,
      candidateName,
    );
  }
  if (fieldOf(execution, "timedOut") === true) {
    throw verificationError(
      `the candidate for ${functionName} did not finish`,
      "the test process exceeded its time limit, which usually means an unbounded loop",
      functionName,
      candidateName,
    );
  }
  const signal = fieldOf(execution, "signal") as string | null;
  if (signal !== null) {
    throw verificationError(
      `the candidate for ${functionName} was terminated by ${signal}`,
      /^SIGILL$/.test(signal)
        ? "the implementation used an instruction this machine does not support; check that target.cpu matches the build host"
        : String(fieldOf(execution, "stderr")).trim().slice(0, 2000),
      functionName,
      candidateName,
    );
  }
  const code = fieldOf(execution, "code") as number | null;
  if (code !== 0) {
    throw verificationError(
      `the candidate for ${functionName} exited with status ${code}`,
      String(fieldOf(execution, "stderr")).trim().slice(0, 2000),
      functionName,
      candidateName,
    );
  }

  const actual = decodeRunResults(contract, String(fieldOf(execution, "stdout")), vectors.length);
  const failures: TestFailure[] = [];
  /** Whether each vector passed, in vector order, so counts can be split by kind and batch. */
  const passedByVector: boolean[] = [];
  expected.forEach((entry, index) => {
    if (fieldOf(entry, "skip") === true) {
      passedByVector[index] = true;
      return;
    }
    const values = fieldOf(entry, "values") as ReadonlyMap<string, Value>;
    const result = fieldOf(entry, "result") as Value;
    const vector = fieldOf(entry, "vector") as TestVector;
    const tolerance = toleranceFor(parsed, values);
    if (!valuesMatch(result, actual[index], tolerance)) {
      passedByVector[index] = false;
      failures.push({
        vector: String(fieldOf(vector, "id")),
        expected: describeValue(result),
        actual: describeValue(actual[index]),
        reason: "result does not match the contract",
      });
      return;
    }
    const violations = postconditionFailures(parsed, values, actual[index], tolerance);
    passedByVector[index] = violations.length === 0;
    for (const violation of violations) {
      failures.push({ vector: String(fieldOf(vector, "id")), expected: violation, actual: describeValue(actual[index]), reason: "postcondition" });
    }
  });

  const first = expected[0];
  const batchSeeds = fieldOf(request, "batchSeeds") as readonly number[] | undefined;
  const batchSizes = fieldOf(request, "batchSizes") as readonly number[] | undefined;
  const batches: VerificationBatch[] = [];
  let at = 0;
  const sizes = batchSizes ?? (batchSeeds === undefined ? [] : [vectors.length]);
  for (let index = 0; index < sizes.length; index += 1) {
    const size = Number(sizes[index]);
    let deterministicPassed = 0;
    let randomPassed = 0;
    const batchFailures: TestFailure[] = [];
    for (let offset = 0; offset < size && at + offset < vectors.length; offset += 1) {
      const position = at + offset;
      const vector = vectors[position];
      if (passedByVector[position] === true) {
        if (vector.kind === "random") randomPassed += 1;
        else deterministicPassed += 1;
      } else {
        batchFailures.push(...failures.filter((failure) => failure.vector === vector.id));
      }
    }
    batches.push({
      seed: Number((batchSeeds ?? [])[index] ?? 0),
      cases: size,
      deterministicPassed,
      randomPassed,
      failures: batchFailures.slice(0, 20),
    });
    at += size;
  }

  let deterministicPassed = 0;
  let randomPassed = 0;
  passedByVector.forEach((passed, index) => {
    if (!passed) return;
    if (vectors[index].kind === "random") randomPassed += 1;
    else deterministicPassed += 1;
  });

  const passed = failures.length === 0;
  return {
    candidate: candidateName,
    passed,
    cases: vectors.length,
    tolerance: first === undefined ? null : toleranceFor(parsed, fieldOf(first, "values") as ReadonlyMap<string, Value>),
    failures: failures.slice(0, 20),
    durationNs: Number(monotonicTimeNs() - started),
    status: passed ? "passed" : "failed",
    seed: Number(fieldOf(request, "seed") ?? (batchSeeds ?? [])[0] ?? 0),
    deterministicPassed,
    randomPassed,
    batches,
  };
}

function describeValue(value: Value): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  return String(value);
}

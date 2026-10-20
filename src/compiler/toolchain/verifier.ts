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
  type BufferValue,
  type Expr,
  type ParsedContract,
  type Value,
} from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { byName } from "../core/named-record.ts";
import { run, GENERATED_HEAP_BYTES } from "../core/process.ts";
import type { FunctionContract, Runner, TestConfig, TestFailure, VerificationResult } from "../core/types.ts";

const BOUNDARY_LENGTHS = [0, 1, 2, 3, 4, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 257, 1023, 1024];

export interface TestVector {
  id: string;
  kind: "fixed" | "boundary" | "random";
  /** Argument values in harness protocol form: text per element, or null. */
  args: Record<string, string | string[] | null>;
}

function verificationError(message: string, detail: string | undefined, functionName: string, candidate?: string): CompilerError {
  return new CompilerError({
    category: "VerificationError",
    stage: "verify",
    message,
    function: functionName,
    candidate,
    detail,
  });
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
  if (lowered === "inf" || lowered === "+inf" || lowered === "infinity") return Number.POSITIVE_INFINITY;
  if (lowered === "-inf" || lowered === "-infinity") return Number.NEGATIVE_INFINITY;
  if (lowered === "nan" || lowered === "-nan") return Number.NaN;
  const parsed = Number(text);
  if (Number.isNaN(parsed)) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: `the candidate printed "${text}", which is not a number`,
    });
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

/** Identifiers that determine how much of a buffer is read. */
function lengthParameters(parsed: ParsedContract): string[] {
  const names = new Set<string>();
  for (const range of [...parsed.contract.memory.reads, ...parsed.contract.memory.writes]) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*\[([^:]+):(.+)\]$/.exec(range.trim());
    if (match === null) continue;
    for (const bound of [match[1], match[2]]) {
      for (const identifier of bound.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        const type = parsed.env.get(identifier);
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
  throw new CompilerError({
    category: "VerificationError",
    stage: "verify",
    message: `cannot generate test values of type ${String(type.name)}`,
  });
}

function patternValue(kind: "zeros" | "ones" | "ramp" | "alternating", index: number): number {
  switch (kind) {
    case "zeros":
      return 0;
    case "ones":
      return 1;
    case "ramp":
      return index % 17;
    case "alternating":
      return index % 2 === 0 ? 1 : -1;
  }
}

interface VectorBuilder {
  id: string;
  kind: TestVector["kind"];
  length: number;
  pattern: "random" | "zeros" | "ones" | "ramp" | "alternating";
  random: () => number;
}

function buildVector(parsed: ParsedContract, builder: VectorBuilder, lengthParameters: readonly string[]): TestVector {
  // Keyed by whatever the source called the parameter, so this is built from
  // entries: a parameter called `__proto__` would otherwise set the prototype
  // of the record instead of adding an argument, and the vector would reach
  // the harness with one argument short.
  const args: (readonly [string, string | string[] | null])[] = [];
  for (const param of parsed.contract.function.params) {
    const type = parseType(param.type);
    if (lengthParameters.includes(param.name)) {
      args.push([param.name, formatScalar(type, BigInt(builder.length))]);
      continue;
    }
    if (type.kind !== "primitive") {
      const element = bufferElement(type);
      const size = type.kind === "array" && type.length !== null ? type.length : builder.length;
      args.push([param.name, Array.from({ length: size }, (_, index) => formatScalar(element, scalarFor(builder, element, index)))]);
      continue;
    }
    args.push([param.name, formatScalar(type, randomScalar(builder.random, type))]);
  }
  return { id: builder.id, kind: builder.kind, args: byName(args) };
}

function scalarFor(builder: VectorBuilder, type: ScalarType, index: number): ScalarValue {
  if (type.name === "bool") return builder.pattern === "ones" ? true : builder.random() < 0.5;
  if (builder.pattern !== "random") {
    const raw = patternValue(builder.pattern, index);
    const value = isSignedName(type.name) ? raw : Math.abs(raw);
    if (isFloatType(type.name as never)) {
      return type.name === "f32" ? Math.fround(value) : value;
    }
    return BigInt(value);
  }
  return randomScalar(builder.random, type);
}

/** Fixed, boundary and randomized vectors, filtered by the preconditions. */
export function planTestVectors(parsed: ParsedContract, config: TestConfig): TestVector[] {
  const lengths = lengthParameters(parsed);
  const random = mulberry32(config.seed);
  const maxLength = Math.max(1, config.maxLength);

  const builders: VectorBuilder[] = [
    { id: "zeros", kind: "fixed", length: 1, pattern: "zeros", random },
    { id: "zeros-17", kind: "fixed", length: 17, pattern: "zeros", random },
    { id: "ones-1", kind: "fixed", length: 1, pattern: "ones", random },
    { id: "ones-8", kind: "fixed", length: 8, pattern: "ones", random },
    { id: "ramp-13", kind: "fixed", length: 13, pattern: "ramp", random },
    { id: "alternating-32", kind: "fixed", length: 32, pattern: "alternating", random },
  ];
  for (const length of BOUNDARY_LENGTHS) {
    if (length > maxLength) continue;
    builders.push({ id: `boundary-${length}`, kind: "boundary", length, pattern: "random", random });
  }
  for (let index = 0; index < Math.max(0, config.randomCases); index += 1) {
    builders.push({
      id: `random-${index}`,
      kind: "random",
      length: Math.floor(random() * (maxLength + 1)),
      pattern: "random",
      random,
    });
  }

  const vectors: TestVector[] = [];
  for (const builder of builders) {
    const vector = buildVector(parsed, builder, lengths);
    const violations = preconditionFailures(parsed, vectorValues(parsed.contract, vector));
    if (violations.length > 0) continue;
    vectors.push(vector);
  }

  if (vectors.length === 0) {
    throw verificationError(
      `no test vector satisfies the preconditions of ${parsed.contract.function.name}`,
      parsed.contract.requires.join("; "),
      parsed.contract.function.name,
    );
  }
  return vectors;
}

/**
 * The vector a delivered program runs when a person starts it with no piped
 * input. It is a fixed pattern rather than a random case, so the number the
 * program prints is the same on every machine, and it is the first planned
 * vector that satisfies the preconditions.
 */
export function selectDemoVector(parsed: ParsedContract, config: TestConfig): TestVector {
  const random = mulberry32(config.seed);
  const lengths = lengthParameters(parsed);
  for (const builder of [
    { id: "demo-8", kind: "fixed" as const, length: 8, pattern: "ramp" as const, random },
    { id: "demo-4", kind: "fixed" as const, length: 4, pattern: "ramp" as const, random },
    { id: "demo-1", kind: "fixed" as const, length: 1, pattern: "ones" as const, random },
  ]) {
    const vector = buildVector(parsed, builder, lengths);
    if (preconditionFailures(parsed, vectorValues(parsed.contract, vector)).length === 0) return vector;
  }
  return planTestVectors(parsed, { ...config, randomCases: 0 })[0];
}

/* -------------------------------------------------------------------------- */
/* Protocol encoding and decoding                                             */
/* -------------------------------------------------------------------------- */

export function vectorValues(contract: FunctionContract, vector: TestVector): Map<string, Value> {
  const values = new Map<string, Value>();
  for (const param of contract.function.params) {
    const type = parseType(param.type);
    const argument = vector.args[param.name];
    if (type.kind !== "primitive") {
      if (argument === null || argument === undefined || typeof argument === "string") {
        values.set(param.name, null);
        continue;
      }
      values.set(param.name, { type, values: argument.map((text) => parseScalar(bufferElement(type), text)) } satisfies BufferValue);
      continue;
    }
    values.set(param.name, argument === undefined ? 0 : parseScalar(type, argument as string));
  }
  return values;
}

export function encodeRunRequest(contract: FunctionContract, vectors: readonly TestVector[]): string {
  const lines = ["run"];
  for (const vector of vectors) {
    const header: string[] = [];
    for (const param of contract.function.params) {
      const type = parseType(param.type);
      const argument = vector.args[param.name];
      header.push(
        type.kind === "primitive"
          ? String(argument)
          : argument === null || argument === undefined || typeof argument === "string"
            ? "-1"
            : String(argument.length),
      );
    }
    lines.push(header.join(" "));
    for (const param of contract.function.params) {
      const type = parseType(param.type);
      if (type.kind === "primitive") continue;
      const argument = vector.args[param.name];
      // An empty or null buffer has no data line, exactly like the harness
      // expects: one line per buffer that actually carries elements.
      if (argument === null || argument === undefined || typeof argument === "string" || argument.length === 0) continue;
      lines.push(argument.join(" "));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function decodeRunResults(contract: FunctionContract, stdout: string, expected: number): Value[] {
  const type = parseType(contract.function.returns);
  const results: Value[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("RESULT ")) continue;
    results.push(parseScalar(type, line.slice("RESULT ".length).trim()));
  }
  if (results.length !== expected) {
    throw verificationError(
      `the candidate produced ${results.length} results for ${expected} test vectors`,
      stdout.trim().slice(0, 400),
      contract.function.name,
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
  const returns = parseType(parsed.contract.function.returns);
  let terms = 1;
  for (const value of values.values()) {
    if (typeof value === "object" && value !== null && "values" in value) {
      terms = Math.max(terms, value.values.length);
    }
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

  parsed.ensures.forEach((condition: Expr, index: number) => {
    const text = parsed.contract.ensures[index];
    if (condition.t === "binary" && condition.op === "==" && condition.left.t === "var" && condition.left.name === "result") {
      const expected = referenceResult({ ...parsed, resultDefinition: condition.right }, values);
      if (!valuesMatch(expected, result, tolerance)) {
        failures.push(`${text} (expected ${String(expected)}, got ${String(result)})`);
      }
      return;
    }
    let outcome: Value;
    try {
      outcome = evaluate(condition, { env: parsed.env, values: bound });
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
  /** The vectors planned once for the whole unit, the same every candidate is checked against. */
  vectors: readonly TestVector[];
}

export function verifyCandidate(request: VerifyRequest): VerificationResult {
  const started = process.hrtime.bigint();
  const { vectors } = request;
  const expected = vectors.map((vector) => {
    const values = vectorValues(request.contract, vector);
    return { vector, values, result: referenceResult(request.parsed, values) };
  });

  // A candidate that allocates without bound is refused by its own allocator
  // under this limit, and says so, rather than being killed by a system that
  // has run out of memory and takes the build with it.
  const execution = run(request.runner.command, request.runner.args, {
    input: encodeRunRequest(request.contract, vectors),
    timeoutMs: 120_000,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  if (execution.spawnError !== undefined) {
    throw verificationError(
      `cannot run the candidate for ${request.contract.function.name}`,
      execution.spawnError,
      request.contract.function.name,
      request.candidate,
    );
  }
  if (execution.timedOut) {
    throw verificationError(
      `the candidate for ${request.contract.function.name} did not finish`,
      "the test process exceeded its time limit, which usually means an unbounded loop",
      request.contract.function.name,
      request.candidate,
    );
  }
  if (execution.signal !== null) {
    throw verificationError(
      `the candidate for ${request.contract.function.name} was terminated by ${execution.signal}`,
      execution.signal === "SIGILL"
        ? "the implementation used an instruction this machine does not support; check that target.cpu matches the build host"
        : execution.stderr.trim().slice(0, 2000),
      request.contract.function.name,
      request.candidate,
    );
  }
  if (execution.code !== 0) {
    throw verificationError(
      `the candidate for ${request.contract.function.name} exited with status ${execution.code}`,
      execution.stderr.trim().slice(0, 2000),
      request.contract.function.name,
      request.candidate,
    );
  }

  const actual = decodeRunResults(request.contract, execution.stdout, vectors.length);
  const failures: TestFailure[] = [];
  expected.forEach((entry, index) => {
    const tolerance = toleranceFor(request.parsed, entry.values);
    if (!valuesMatch(entry.result, actual[index], tolerance)) {
      failures.push({
        vector: entry.vector.id,
        expected: describeValue(entry.result),
        actual: describeValue(actual[index]),
        reason: "result does not match the contract",
      });
      return;
    }
    for (const violation of postconditionFailures(request.parsed, entry.values, actual[index], tolerance)) {
      failures.push({ vector: entry.vector.id, expected: violation, actual: describeValue(actual[index]), reason: "postcondition" });
    }
  });

  return {
    candidate: request.candidate,
    passed: failures.length === 0,
    cases: vectors.length,
    tolerance: expected.length === 0 ? null : toleranceFor(request.parsed, expected[0].values),
    failures: failures.slice(0, 20),
    durationNs: Number(process.hrtime.bigint() - started),
  };
}

function describeValue(value: Value): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  return String(value);
}

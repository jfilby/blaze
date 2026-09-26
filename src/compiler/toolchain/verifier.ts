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
  isFloatType,
  isIntegerType,
  parseType,
  preconditionFailures,
  referenceResult,
  valuesMatch,
  type BufferValue,
  type Expr,
  type ParsedContract,
  type Value,
} from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
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
        if (parsed.env.has(identifier)) names.add(identifier);
      }
    }
  }
  return [...names];
}

function isSignedName(name: string | undefined): boolean {
  return name === "isize" || (name !== undefined && name.startsWith("i"));
}

function randomScalar(random: () => number, type: ScalarType): ScalarValue {
  if (type.name === "bool") return random() < 0.5;
  if (isFloatType(type.name as never)) {
    const signed = (random() - 0.5) * (1 + Math.floor(random() * 64));
    const value = type.name === "f32" ? Math.fround(signed) : signed;
    return random() < 0.2 ? 0 : value;
  }
  if (type.kind === "primitive" && isIntegerType(type.name as never)) {
    const choice = random();
    if (choice < 0.15) return 0n;
    if (choice < 0.3) return BigInt(1 + Math.floor(random() * 4));
    if (choice < 0.8) return BigInt(Math.floor(random() * (2 + Math.floor(random() * 64))));
    if (!isSignedName(type.name)) return BigInt(1 + Math.floor(random() * 256));
    return BigInt(-Math.floor(random() * 16));
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
  const args: Record<string, string | string[] | null> = {};
  for (const param of parsed.contract.function.params) {
    const type = parseType(param.type);
    if (lengthParameters.includes(param.name)) {
      args[param.name] = formatScalar(type, BigInt(builder.length));
      continue;
    }
    if (type.kind !== "primitive") {
      const element = type.of;
      const size = type.kind === "array" && type.length !== null ? type.length : builder.length;
      args[param.name] = Array.from({ length: size }, (_, index) => formatScalar(element, scalarFor(builder, element, index)));
      continue;
    }
    args[param.name] = formatScalar(type, randomScalar(builder.random, type));
  }
  return { id: builder.id, kind: builder.kind, args };
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
      values.set(param.name, { type, values: argument.map((text) => parseScalar(type.of, text)) } satisfies BufferValue);
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
  config: TestConfig;
}

export function verifyCandidate(request: VerifyRequest): VerificationResult {
  const started = process.hrtime.bigint();
  const vectors = planTestVectors(request.parsed, request.config);
  const expected = vectors.map((vector) => {
    const values = vectorValues(request.contract, vector);
    return { vector, values, result: referenceResult(request.parsed, values) };
  });

  const execution = run(request.runner.command, request.runner.args, {
    input: encodeRunRequest(request.contract, vectors),
    timeoutMs: 120_000,
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

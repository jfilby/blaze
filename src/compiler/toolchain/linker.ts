/**
 * Linking.
 *
 * The compiler never interprets model output itself. It wraps the candidate
 * object in a harness it generates from the contract, so the only thing the
 * model controls is the body of the contracted function. The harness parses
 * test vectors on stdin, calls the function with the System V AMD64 ABI and
 * prints results in an exactly round-trippable form.
 *
 * Protocol (stdin):
 *
 *   run
 *   <token> ...          one line per call: a length per buffer parameter,
 *                        then a value per scalar parameter, in signature order
 *   <elements> ...       one line per buffer parameter, in signature order
 *   ...
 *
 *   bench <iterations>
 *   <token> ...
 *   <elements> ...
 *
 * A length of -1 means a null pointer. Output (stdout):
 *
 *   RESULT <value>       one line per call in run mode
 *   BENCH <nanoseconds> <sink>
 */

import { bufferElement, isFloatType, isSignedIntegerType, parseType, symbolOf, typeToString } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { BuildMode, FunctionContract, FunctionParam, ObjectLayout, TypeExpr } from "../core/types.ts";
import { linkOptions } from "../core/target.ts";
import type { ProbePlan } from "./probe.ts";
import { RUNTIME_NAME, RUNTIME_SYMBOLS } from "../runtime/abi.ts";
import { C_KEYWORDS, cEscape, cHeaderNames, cMemberName } from "./c-names.ts";

const INTEGER_ARGUMENT_REGISTERS = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
const SSE_ARGUMENT_REGISTERS = ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"];

const C_SCALARS: Record<string, string> = {
  bool: "bool",
  i8: "int8_t",
  i16: "int16_t",
  i32: "int32_t",
  i64: "int64_t",
  u8: "uint8_t",
  u16: "uint16_t",
  u32: "uint32_t",
  u64: "uint64_t",
  f32: "float",
  f64: "double",
  usize: "size_t",
  isize: "intptr_t",
};

function linkError(message: string, detail?: string, functionName?: string): CompilerError {
  return new CompilerError({ category: "LinkError", stage: "link", message, function: functionName, detail });
}

function isFloatScalar(type: TypeExpr): boolean {
  return type.kind === "primitive" && isFloatType(type.name);
}

type BufferType = Extract<TypeExpr, { kind: "ptr" | "slice" | "array" }>;

function isBuffer(type: TypeExpr): type is BufferType {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array";
}

function isSignedScalar(type: TypeExpr): boolean {
  return type.kind === "primitive" && isSignedIntegerType(type.name);
}

/** C type used in the harness declaration for a contract type. */
export function cDeclarationType(type: TypeExpr): string {
  if (type.kind === "void") return "void";
  if (type.kind === "ref") return type.name === undefined ? "void*" : `struct ${type.name}*`;
  if (isBuffer(type)) return `${cDeclarationType(type.of)}*`;
  if (type.kind !== "primitive") throw linkError(`unsupported type ${typeToString(type)}`);
  const mapped = C_SCALARS[type.name];
  if (mapped === undefined) throw linkError(`unsupported type ${typeToString(type)}`);
  return mapped;
}

/**
 * The C declarations of the objects a contract lays out, in the order the
 * contract names them. A candidate, a harness and a driver all include them, so
 * a field is at the same offset everywhere: `offsetof` in the definition is the
 * offset the contract states.
 */


export function cObjectDeclarations(objects: Record<string, ObjectLayout>): string {
  return Object.values(objects)
    .map((object) => {
      // A field is named by whatever the source called it, and a C keyword is
      // a legal identifier to the compiler and a reserved word to the C
      // compiler: `struct { double long; }` is not C, so a source with a field
      // called `long` produced a driver, a harness and a probe that no target
      // compiler takes. The Nim host already writes its fields under names of
      // their own, and a member is in a namespace of its own, so a typedef the
      // headers define is still a legal member; a keyword and a macro are not.
      const fields = object.fields
        .map(
          (field) =>
            `  ${cDeclarationType(parseType(field.type))} ${cMemberName(field.name)}; /* +${field.offset} */`,
        )
        .join("\n");
      return `struct ${object.name} {\n${fields}\n}; /* ${object.size} bytes, align ${object.align} */`;
    })
    .join("\n");
}


/** System V AMD64 argument locations, so the model knows where values arrive. */
export function sysvArgumentLocations(params: readonly FunctionParam[]): string {
  let integerIndex = 0;
  let sseIndex = 0;
  const locations: string[] = [];
  for (const param of params) {
    const type = parseType(param.type);
    const register = isFloatScalar(type) ? SSE_ARGUMENT_REGISTERS[sseIndex++] : INTEGER_ARGUMENT_REGISTERS[integerIndex++];
    if (register === undefined) {
      throw linkError(`argument "${param.name}" does not fit in registers`, undefined, undefined);
    }
    locations.push(`${param.name} -> ${register}`);
  }
  return locations.length === 0 ? "no arguments" : locations.join(", ");
}

/**
 * System V AMD64 return location, so a model knows where to leave the result.
 * The harness and the driver declare the function in C, so this is the
 * convention the C compiler reads the return value by.
 */
export function sysvReturnLocation(type: TypeExpr): string {
  if (type.kind === "void") return "nothing: the function returns no value";
  return isFloatScalar(type) ? "xmm0" : "rax";
}

/* -------------------------------------------------------------------------- */
/* Harness generation                                                         */
/* -------------------------------------------------------------------------- */

/** C expression that parses `token` into a value of the given scalar type. */
function scalarReadExpression(type: TypeExpr, token: string): string {
  const cType = cDeclarationType(type);
  if (type.kind === "primitive" && type.name === "bool") return `(${token}[0] == 't' || ${token}[0] == '1')`;
  if (isFloatScalar(type)) {
    return type.kind === "primitive" && type.name === "f32"
      ? `(float)strtof(${token}, NULL)`
      : `strtod(${token}, NULL)`;
  }
  return isSignedScalar(type) ? `(${cType})strtoll(${token}, NULL, 10)` : `(${cType})strtoull(${token}, NULL, 10)`;
}

function fixedLength(type: TypeExpr): number | null {
  return type.kind === "array" && type.length !== null ? type.length : null;
}

const HARNESS_PRELUDE = `/* Generated by the blaze compiler from a function contract. Do not edit. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "${RUNTIME_NAME}.h"

static char* input_line = NULL;
static FILE* input;

static size_t input_capacity = 0;

static void fail(const char* message) {
  fprintf(stderr, "harness: %s\\n", message);
  exit(2);
}

/* Returns the next whitespace separated token, terminated in place. */
static char* next_token(char** cursor) {
  char* position = *cursor;
  while (*position == ' ' || *position == '\\t' || *position == '\\r' || *position == '\\n') position += 1;
  if (*position == '\\0') return NULL;
  char* start = position;
  while (*position != '\\0' && *position != ' ' && *position != '\\t' && *position != '\\r' && *position != '\\n') position += 1;
  if (*position != '\\0') {
    *position = '\\0';
    position += 1;
  }
  *cursor = position;
  return start;
}

static int is_blank(char* line) {
  while (*line == ' ' || *line == '\\t' || *line == '\\r' || *line == '\\n') line += 1;
  return *line == '\\0';
}

static long long now_ns(void) {
  struct timespec moment;
  clock_gettime(CLOCK_MONOTONIC, &moment);
  return (long long)moment.tv_sec * 1000000000LL + (long long)moment.tv_nsec;
}
`;

/**
 * The names the harness has already taken, for a contract that wrote a name
 * down as one of them. The harness holds each argument in a file-scope static
 * named after the contract's parameter, so a parameter called `value` is a
 * second `value` in `main` and the call reads the local instead of the vector:
 * the candidate is verified against an indeterminate number and the build says
 * it is wrong. A parameter called `input` is a redeclaration of the prelude's
 * and the harness does not compile at all. The harness side is the side that
 * has to be right, so the parameter is written down under a C name of its own.
 *
 * The prelude's names are read out of the prelude itself, so adding a helper
 * cannot leave the list behind. The names `main` holds are listed, because they
 * are written in the body of `generateHarness` rather than in the prelude.
 */
const HARNESS_RESERVED: Record<string, true> = {
  ...C_KEYWORDS,
  ...cHeaderNames(),
  ...RUNTIME_SYMBOLS,
  ...Object.fromEntries(
    [...HARNESS_PRELUDE.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map(
      (match) => [match[0], true as const],
    ),
  ),
  // main's own entry, and everything held in its scope.
  main: true,
  value: true,
  sink: true,
  mode: true,
  mode_cursor: true,
  bench_mode: true,
  count_token: true,
  // Held as a local while a vector is read. It is not named in the prelude,
  // so a parameter of that name is not moved aside of it: the local shadows the
  // argument, and the harness stores the parsed value into a `char *`.
  token: true,
  iterations: true,
  iteration: true,
  calls: true,
  start: true,
  elapsed: true,
  demo_request: true,
  read_header: true,
  read_data: true,
};

/** The storage each parameter is written into when a vector is read. */
const ARGUMENT_STORAGE_PREFIXES: readonly string[] = ["count_", "storage_", "declared_"];

/**
 * The C names the parameters of a signature are written down under. A buffer
 * parameter is read into a `count_`/`storage_` pair, so a parameter whose own
 * name is one of those pairs for a sibling has to move as well, and a name that
 * moves takes its pair with it. The set grows until nothing moves, which it
 * does after one pass for any signature a person would write.
 */
function harnessArgumentNames(names: readonly string[]): string[] {
  const reserved: Record<string, true> = { ...HARNESS_RESERVED };
  let escaped = names.map((name) => cEscape(name, reserved));
  for (;;) {
    for (const name of escaped) {
      for (const prefix of ARGUMENT_STORAGE_PREFIXES) reserved[`${prefix}${name}`] = true;
    }
    const next = names.map((name) => cEscape(name, reserved));
    if (next.every((name, index) => name === escaped[index])) return escaped;
    escaped = next;
  }
}

function vectorCounters(types: readonly TypeExpr[], names: readonly string[]): string {
  return types
    .map((type, index) => (isBuffer(type) ? `static size_t count_${names[index]};` : ""))
    .filter((line) => line !== "")
    .join("\n");
}

/** Reads the header line of the next vector into the static arguments. */
function headerReader(types: readonly TypeExpr[], names: readonly string[], labels: readonly string[]): string {
  const body: string[] = ["  if (getline(&input_line, &input_capacity, input) <= 0) return 0;"];
  // A vector of a function that takes nothing is an empty line, so a blank one
  // is only a line to skip where there are arguments on it to read.
  if (types.length > 0) body.push("  if (is_blank(input_line)) return read_header();");
  body.push("  char* cursor = input_line;");
  types.forEach((type, index) => {
    const name = names[index];
    const label = labels[index];
    if (type.kind === "primitive") {
      body.push("  {");
      body.push(`    char* token = next_token(&cursor);`);
      body.push(`    if (token == NULL) fail("missing value for ${label}");`);
      body.push(`    ${name} = (${cDeclarationType(type)})${scalarReadExpression(type, "token")};`);
      body.push("  }");
      return;
    }
    const length = fixedLength(type);
    const elementType = cDeclarationType(bufferElement(type));
    body.push("  {");
    body.push(`    char* token = next_token(&cursor);`);
    body.push(`    if (token == NULL) fail("missing length for ${label}");`);
    body.push(`    const long declared_${name} = strtol(token, NULL, 10);`);
    if (length !== null) {
      body.push(`    if (declared_${name} != ${length}) fail("${label} must have length ${length}");`);
    }
    body.push(
      `    count_${name} = ${length === null ? `(declared_${name} < 0 ? 0 : (size_t)declared_${name})` : String(length)};`,
    );
    body.push(`    storage_${name} = NULL;`);
    body.push(`    ${name} = NULL;`);
    body.push(`    if (declared_${name} >= 0) {`);
    body.push(`      if (count_${name} > (1u << 28)) fail("buffer too large");`);
    body.push(`      if (count_${name} != 0) {`);
    body.push(`        storage_${name} = (${elementType}*)malloc(count_${name} * sizeof(${elementType}));`);
    body.push(`        if (storage_${name} == NULL) fail("out of memory");`);
    body.push("      }");
    body.push(`      ${name} = storage_${name};`);
    body.push("    }");
    body.push("  }");
  });

  return body.join("\n");
}

/** Reads the data line of every buffer parameter of the current vector. */
function dataReader(types: readonly TypeExpr[], names: readonly string[], labels: readonly string[]): string {
  const body: string[] = [];
  types.forEach((type, index) => {
    if (type.kind === "primitive") return;
    const name = names[index];
    body.push(`  if (count_${name} != 0) {`);
    body.push(`    if (getline(&input_line, &input_capacity, input) <= 0) fail("missing data for ${labels[index]}");`);
    body.push("    char* cursor = input_line;");
    body.push(`    for (size_t element = 0; element < count_${name}; element += 1) {`);
    body.push(`      char* token = next_token(&cursor);`);
    body.push(`      if (token == NULL) fail("truncated data for ${labels[index]}");`);
    body.push(`      storage_${name}[element] = ${scalarReadExpression(bufferElement(type), "token")};`);
    body.push("    }");
    body.push("  }");
  });
  return body.join("\n");
}

/** File-scope storage for the arguments of the current vector. */
function vectorStorage(types: readonly TypeExpr[], names: readonly string[]): string {
  const lines: string[] = [];
  types.forEach((type, index) => {
    if (!isBuffer(type)) return;
    lines.push(`static ${cDeclarationType(type.of)}* storage_${names[index]};`);
  });
  return lines.join("\n");
}

function resultPrint(returns: TypeExpr): string {
  // 17 significant digits read back as the same double, so the comparison
  // against the reference is exact up to the contract's tolerance.
  if (isFloatScalar(returns)) return 'printf("RESULT %.17g\\n", (double)value);';
  if (returns.kind === "primitive" && returns.name === "bool") return 'printf("RESULT %d\\n", value ? 1 : 0);';
  if (isSignedScalar(returns)) return 'printf("RESULT %lld\\n", (long long)value);';
  return 'printf("RESULT %llu\\n", (unsigned long long)value)';
}

/** Renders text as a C string literal, one source line per protocol line. */
function cStringLiteral(text: string): string {
  return text
    .split("\n")
    .map((line) => `  "${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\\n"`)
    .join("\n");
}

/** Emits the C harness for a contract. The harness is compiler code. */
export function generateHarness(contract: FunctionContract, demoRequest: string): string {
  const name = symbolOf(contract);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw linkError("the contract function name is not a valid C identifier", undefined, name);
  }
  if (contract.ensures.length === 0) return generateDefinitionHarness(contract);
  const returns = parseType(contract.function.returns);
  if (isBuffer(returns)) throw linkError("a pointer return type cannot be called from the harness", undefined, name);
  // The harness is C and the C compiler places the arguments, so an arity past
  // the registers is a harness that still compiles: a ninth argument goes on
  // the stack. Asking for a register for each one refused a contract whose
  // harness was about to be written perfectly well.

  const types = contract.function.params.map((param) => parseType(param.type));
  const labels = contract.function.params.map((param) => param.name);
  const names = harnessArgumentNames(labels);
  for (const type of types) {
    if (type.kind === "array" && type.length === null) {
      throw linkError("array parameters need a fixed length", undefined, name);
    }
  }
  const callArguments = names.join(", ");
  const invocation =
    contract.function.params.length === 0
      ? `${cDeclarationType(returns)} value = ${name}();`
      : `${cDeclarationType(returns)} value = ${name}(${callArguments});`;

  return `${HARNESS_PRELUDE}
extern ${cDeclarationType(returns)} ${name}(${types.map((type, index) => `${cDeclarationType(type)} ${names[index]}`).join(", ")});

${types.map((type, index) => `static ${cDeclarationType(type)} ${names[index]};`).join("\n")}
${vectorCounters(types, names)}
/* The example run, used when a person starts this program with no input. */
static const char demo_request[] =
${cStringLiteral(demoRequest)};
${vectorStorage(types, names)}

/* Reads the header line of the next vector; returns 0 at end of input. */
static int read_header(void) {
${headerReader(types, names, labels)}
  return 1;
}

/* Reads one data line per buffer parameter of the current vector. */
static void read_data(void) {
${dataReader(types, names, labels)}
}
int main(void) {
  static volatile double sink = 0.0;
  /* A terminal means a person ran the program, so it runs the example
     instead of waiting for vectors that will never arrive. A pipe is the
     compiler driving it, and keeps the protocol exactly as it was. */
  if (isatty(0)) {
    input = fmemopen((void*)demo_request, sizeof(demo_request) - 1, "r");
    if (input == NULL) fail("cannot read the example run");
    printf("no input given: running ${name} on a built-in example vector\\n");
  } else {
    input = stdin;
  }
  /* The harness is the host program: the runtime lives for the whole run. */
  blaze_rt_initialize();
  if (getline(&input_line, &input_capacity, input) <= 0) fail("empty input");
  char* mode_cursor = input_line;
  char* mode = next_token(&mode_cursor);
  if (mode == NULL) fail("empty input");
  const int bench_mode = strcmp(mode, "bench") == 0;
  long long iterations = 1;
  if (bench_mode) {
    char* count_token = next_token(&mode_cursor);
    if (count_token == NULL) fail("bench requires an iteration count");
    iterations = atoll(count_token);
    if (iterations <= 0) fail("bench requires a positive iteration count");
  } else if (strcmp(mode, "run") != 0) {
    fail("expected mode run or bench");
  }

  if (!read_header()) fail("no test vector");
  read_data();

  if (!bench_mode) {
    int calls = 0;
    for (;;) {
      ${invocation}
      ${resultPrint(returns)}
      calls += 1;
      if (!read_header()) break;
      read_data();
    }
    if (calls == 0) fail("no test vectors");
    blaze_rt_finalize();
    return 0;
  }

  const long long start = now_ns();
  for (long long iteration = 0; iteration < iterations; iteration += 1) {
    ${invocation}
    sink += (double)value;
  }
  const long long elapsed = now_ns() - start;
  printf("BENCH %lld %.17g\\n", elapsed, (double)sink);
  blaze_rt_finalize();
  return 0;
}
`;
}

/**
 * The harness of a function whose contract states what it does rather than what
 * it returns. There is no vector to call it with, and no result to print: the
 * harness exists so the object is assembled and linked against the same ABI the
 * program links, and the program is what says whether the two agree.
 */
function generateDefinitionHarness(contract: FunctionContract): string {
  const name = symbolOf(contract);
  const objects = contract.definition.objects;
  // The names appear only in the extern declaration, so all they have to be is
  // well formed: a contract is free to call a parameter `double`, and an
  // unescaped one makes gcc reject the whole harness. The sibling
  // `generateHarness` solves the same problem for the names it also calls.
  const parameters = contract.function.params
    .map((param) => `${cDeclarationType(parseType(param.type))} ${cEscape(param.name, HARNESS_RESERVED)}`)
    .join(", ");
  const declarations = cObjectDeclarations(objects);
  return `/* Generated by the blaze compiler from a function contract. Do not edit.
 * ${name} is checked by the program it is part of, so this harness only links. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "${RUNTIME_NAME}.h"

${declarations}

extern ${cDeclarationType(parseType(contract.function.returns))} ${name}(${parameters || "void"});

int main(void) {
  blaze_rt_initialize();
  blaze_rt_finalize();
  return 0;
}
`;
}

/**
 * The harness that calls a definition-contract candidate once, on an input
 * built from its own contract, and throws the result away.
 *
 * It says nothing about what the candidate computes. It says that the call was
 * made and came back, which a candidate that faults inside the runtime it was
 * linked against cannot: the result is not read, not printed and not compared
 * with anything, so a candidate that returns nonsense passes this and is still
 * the program to judge. What this rejects is a candidate that dies, which is
 * the one defect that would otherwise cost a whole round of the program to find
 * and a regeneration of every function in it.
 */
export function generateProbeHarness(contract: FunctionContract, plan: ProbePlan & { kind: "call" }): string {
  const name = symbolOf(contract);
  const objects = contract.definition.objects;
  const parameters = contract.function.params
    .map((param) => `${cDeclarationType(parseType(param.type))} ${cEscape(param.name, HARNESS_RESERVED)}`)
    .join(", ");
  const declarations = cObjectDeclarations(objects);
  const returns = cDeclarationType(parseType(contract.function.returns));
  const call = `${name}(${plan.callArguments.join(", ")})`;
  // A function that returns nothing has nothing to hold, and a variable of
  // type void is not C.
  const result =
    returns === "void" ? `  ${call};` : `  volatile ${returns} probe_result = ${call};\n  (void)probe_result;`;
  return `/* Generated by the blaze compiler from a function contract. Do not edit.
 * ${name} is called once on an input built from its contract. The result is not
 * read: the program it belongs to is what says whether the two agree. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "${RUNTIME_NAME}.h"

${declarations}

extern ${returns} ${name}(${parameters || "void"});

int main(void) {
  ${RUNTIME_NAME}_initialize();
${plan.statements.map((statement) => `  ${statement}`).join("\n")}
${result}
  ${RUNTIME_NAME}_finalize();
  return 0;
}
`;
}

/* -------------------------------------------------------------------------- */
/* Link                                                                       */
/* -------------------------------------------------------------------------- */

export interface LinkRequest {
  /** How the C compiler is asked to build, from the project's mode. */
  mode: BuildMode;
  harnessPath: string;
  objectPath: string;
  /** Directories the generated source includes the runtime header from. */
  includeDirectories?: string[];
  /** The compiler runtime object, when the build links one. */
  runtimeObjectPath?: string;
  outputPath: string;
  functionName: string;
}

export function link(request: LinkRequest): void {
  const inputs = [request.harnessPath, request.objectPath];
  if (request.runtimeObjectPath !== undefined) inputs.push(request.runtimeObjectPath);
  // The harness includes the runtime header by name, and a build keeps the
  // runtime beside the work directory rather than beside every candidate.
  const includes = (request.includeDirectories ?? []).flatMap((directory) => [`-I`, directory]);
  // A function the compiler lowered from IR may call the maths library, and a
  // harness or a probe that runs one links it in.
  const result = run("gcc", [...linkOptions(request.mode), ...includes, "-Wl,--gc-sections", "-o", request.outputPath, ...inputs, "-lm"], { timeoutMs: 120_000 });
  if (result.spawnError !== undefined) {
    throw linkError("the C compiler is not available", result.spawnError, request.functionName);
  }
  if (result.code !== 0) {
    throw linkError(
      `linking failed for ${request.functionName}`,
      `${result.command}\n${result.stderr.trim()}`,
      request.functionName,
    );
  }
}

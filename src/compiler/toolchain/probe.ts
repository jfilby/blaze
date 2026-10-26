/**
 * Synthesizing an input a definition-contract candidate can be called with.
 *
 * A contract that states what a function does rather than what it returns has
 * no test vector and no reference value, so nothing runs a candidate on its own
 * until the whole program is linked and what it prints is compared with what
 * the source prints. A candidate that cannot execute at all is therefore
 * indistinguishable from one that can, right up until a round of the program,
 * which regenerates every function in it, has been spent finding out.
 *
 * So a definition-contract candidate is called once, on an input built from its
 * own contract: zero for a number, false for a boolean, a null pointer for a
 * buffer, a null reference for one the contract does not lay out, and a freshly
 * allocated object with its fields defaulted for one it does. The result is
 * thrown away. Nothing here says what the function computes and nothing is
 * compared with anything; the only question is whether the candidate gets
 * through the call and comes back.
 *
 * An input the contract's own preconditions reject is no evidence at all, so no
 * harness is built for it: the probe is skipped, and a candidate is never turned
 * away over a case the contract itself excludes.
 */

import { parseType, preconditionFailures, type ParsedContract, type Value } from "../semantics/contract.ts";
import type { FunctionContract, ObjectLayout, TypeExpr } from "../core/types.ts";
import { cLiteral, cMemberName } from "./c-names.ts";
import { RUNTIME_NAME } from "../runtime/abi.ts";

/** The C statements that build one argument, and the expression the call passes. */
export interface ProbeArgument {
  /** C statements to run before the call, in order. */
  readonly statements: readonly string[];
  /** The C expression the call passes. */
  readonly value: string;
}

export type ProbePlan =
  /** The candidate is to be called once with these arguments. */
  | { readonly kind: "call"; readonly statements: readonly string[]; readonly callArguments: readonly string[] }
  /**
   * The contract will not say the default input is a legal one, so nothing is
   * run: either there is no definition to build an input from, or the
   * preconditions it would have to satisfy say the input is outside the
   * function's domain.
   */
  | { readonly kind: "skip"; readonly reason: string };

/** How deep a default object is built, so a layout that reaches itself ends. */
const MAX_OBJECT_DEPTH = 4;

/** The C type a contract type is declared with in a harness. */
function cType(type: TypeExpr): string {
  if (type.kind === "void") return "void";
  if (type.kind === "primitive") {
    const scalars: Record<string, string> = {
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
    return scalars[type.name];
  }
  if (type.kind === "ref") return type.name === undefined ? "void*" : `struct ${type.name}*`;
  return "void*";
}

/** The value a scalar of the type holds when nothing is known about it. */
function defaultScalar(type: TypeExpr): string {
  if (type.kind === "primitive" && type.name === "bool") return "false";
  // A wide number is four limbs and no C scalar, so the zero it defaults to is
  // the initializer list that says which limb is which. Written as `0` it is
  // `passing argument 1 of 'wide' from incompatible pointer type`, and the
  // candidate was faulted for a call the harness wrote.
  if (type.kind === "primitive" && (type.name === "u256" || type.name === "i256")) return cLiteral("0", type.name);
  return "0";
}

/**
 * The statements that build a value of `type`, and the expression naming it.
 *
 * A reference to an object the contract lays out is allocated through the
 * runtime, so the payload lands where the contract says its fields are and a
 * candidate that releases it releases a block the runtime owns. Its fields are
 * defaulted rather than filled: a field that is itself a reference is null, so
 * a layout whose objects point at each other is built to a fixed depth instead
 * of until the stack runs out.
 */
/** Whether a reference points at an object the contract lays out, and so has a shape. */
function laidOut(type: Extract<TypeExpr, { kind: "ref" }>, objects: Record<string, ObjectLayout>): boolean {
  return type.name !== undefined && objects[type.name] !== undefined;
}

function buildValue(
  type: TypeExpr,
  name: string,
  objects: Record<string, ObjectLayout>,
  statements: string[],
  depth: number,
): string {
  if (type.kind === "ref" && laidOut(type, objects)) {
    const object = objects[type.name as string];
    if (depth >= MAX_OBJECT_DEPTH) return "NULL";
    const pointer = `${name}_probe`;
    statements.push(
      `struct ${type.name}* ${pointer} = (struct ${type.name}*)${RUNTIME_NAME}_object_new(${object.size}, ${object.align});`,
    );
    statements.push(`if (${pointer} == NULL) { fprintf(stderr, "probe: out of memory\\n"); exit(2); }`);
    for (const field of object.fields) {
      const fieldType = parseType(field.type);
      statements.push(
        `${pointer}->${cMemberName(field.name)} = (${cType(fieldType)})(${buildValue(fieldType, `${name}_${field.name}`, objects, statements, depth + 1)});`,
      );
    }
    return pointer;
  }
  if (type.kind === "ref") return type.name === undefined ? "NULL" : `(struct ${type.name}*)NULL`;
  if (type.kind === "primitive") return defaultScalar(type);
  if (type.kind === "void") return "NULL";
  if (type.kind === "text") return "NULL";
  // A buffer is built as a real one, of the length the contract states, and
  // not as a null pointer. The preconditions are read against a buffer that
  // is there — `probeValue` reports an empty buffer as a buffer, not as a null
  // pointer — so passing NULL to a call the compiler had just accepted
  // `a != null` for killed a candidate that was doing exactly what it was
  // written to do, and a whole function's candidates were rejected for it. The
  // count is the one the contract states, so a precondition that needs
  // elements to be there refuses the call before it is made.
  const element = cType(type.of);
  // A pointer of any type is the size of a pointer, which is written the way
  // C spells it rather than through a type that is a GNU extension.
  const elementSize = element.endsWith("*") ? "sizeof(void*)" : `sizeof(${element})`;
  const count = type.kind === "array" ? (type.length ?? 0) : 0;
  const pointer = `${name}_probe_buffer`;
  statements.push(`void* ${pointer} = ${RUNTIME_NAME}_array_new(${count}, ${elementSize});`);
  statements.push(`if (${pointer} == NULL) { fprintf(stderr, "probe: out of memory\\n"); exit(2); }`);
  return `(${element}*)${pointer}`;
}

/** The contract-level value a default argument has, for reading preconditions. */
function probeValue(type: TypeExpr): Value {
  if (type.kind === "primitive") return type.name === "bool" ? false : 0;
  if (type.kind === "ptr" || type.kind === "slice" || type.kind === "array") {
    return { type, values: [] };
  }
  return null;
}

/**
 * What it would take to call this contract's function with an input built from
 * the contract itself, or why no such call may be made.
 *
 * The preconditions are read here rather than in the harness, because the
 * compiler and not the candidate is what knows whether the default input is
 * inside the function's domain. Where it is not, the honest answer is that
 * there is nothing to run, not that the candidate is wrong.
 */
export function planProbe(contract: FunctionContract, parsed: ParsedContract): ProbePlan {
  if (contract.ensures.length > 0) {
    return {
      kind: "skip",
      reason: "the contract states what the function returns, so the candidate is verified against its own vectors",
    };
  }
  const parameters = contract.function.params.map((param) => ({ name: param.name, type: parseType(param.type) }));
  const objects = contract.definition.objects;
  const values = new Map<string, Value>(parameters.map((param) => [param.name, probeValue(param.type)]));
  const failures = preconditionFailures(parsed, values);
  if (failures.length > 0) {
    return {
      kind: "skip",
      reason: `the input built from the contract is outside the domain it states: ${failures.join("; ")}`,
    };
  }

  // A reference the contract does not lay out is not a value the compiler can
  // build, and passing a null one would be the compiler asserting something the
  // contract never said: that null is a legal argument, which a candidate that
  // reads through the reference is then faulted for believing. An `any` that was
  // never narrowed is exactly this, so nothing is run against one.
  const unbuildable = parameters.find((param) => param.type.kind === "ref" && !laidOut(param.type, objects));
  if (unbuildable !== undefined) {
    return {
      kind: "skip",
      reason: `the parameter "${unbuildable.name}" is a reference to an object the contract does not lay out, so no input can be built for it`,
    };
  }

  const statements: string[] = [];
  const callArguments = parameters.flatMap((param) => {
    const base = buildValue(param.type, param.name, objects, statements, 0);
    if (param.type.kind === "array" || param.type.kind === "slice" || param.type.kind === "ptr") {
      const count = param.type.kind === "array" ? (param.type.length ?? 0) : 0;
      return [base, String(count)];
    }
    return [base];
  });
  return { kind: "call", statements, callArguments };
}

/**
 * The input a module is called with when it is probed, or why no such call may
 * be made.
 *
 * A module is called through the host that runs it, and the host reads the
 * vector protocol: a mode line, a line of arguments and a line of elements for
 * every buffer among them. What is settled here is the same thing the native
 * probe settles — that the candidate came back — and the input is the one the
 * contract itself describes.
 *
 * A parameter the vector protocol does not carry is a reason to skip rather
 * than a reason to guess: a text is not a number and a reference is not a
 * buffer, and the host reads neither.
 */
export function wasmProbeInput(
  contract: FunctionContract,
  parsed: ParsedContract,
): { kind: "call"; input: string } | { kind: "skip"; reason: string } {
  const plan = planProbe(contract, parsed);
  if (plan.kind === "skip") return plan;
  const header: string[] = [];
  const data: string[] = [];
  for (const param of contract.function.params) {
    const type = parseType(param.type);
    if (type.kind === "primitive") {
      // A whole number of thirty-two bits or more is a number the protocol
      // carries as a decimal, and a wide one is thirty-two bytes the protocol
      // does not carry at all.
      if (type.name === "u256" || type.name === "i256") {
        return { kind: "skip", reason: `the parameter "${param.name}" is a wide number, which the vector protocol does not carry` };
      }
      header.push(type.name === "bool" ? "0" : "0");
      continue;
    }
    if (type.kind === "text") {
      return { kind: "skip", reason: `the parameter "${param.name}" is a text, which the vector protocol does not carry` };
    }
    if (type.kind === "ref") {
      return { kind: "skip", reason: `the parameter "${param.name}" is a reference, which the vector protocol does not carry` };
    }
    // A buffer is a count and its elements, and the count is the one the
    // contract states.
    const count = type.kind === "array" ? (type.length ?? 0) : 0;
    header.push(String(count));
    data.push(new Array(count).fill("0").join(" "));
  }
  const lines = ["run", header.join(" ")];
  for (const line of data) lines.push(line);
  // A function that takes nothing is called with an empty header line, which
  // is a line of its own.
  if (header.length === 0) lines.push("");
  return { kind: "call", input: `${lines.join("\n")}\n` };
}

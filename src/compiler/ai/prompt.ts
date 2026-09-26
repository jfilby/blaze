/**
 * Prompt construction for the AI backend.
 *
 * The prompt states the target, the ABI, the function signature, the semantic
 * and memory requirements, the numerical semantics and the optimization
 * objective. It also states the program the function belongs to: the source of
 * the module being written, the contract of every other file, and the imports
 * between them, so a backend never has to infer a cross-file contract. It
 * never dictates an implementation strategy.
 */

import type { FunctionContract, OutputKind, ProgramContract, RuntimeKind, SourceModule, TargetSpec } from "../core/types.ts";
import { isBufferType, parseType, typeToString } from "../semantics/contract.ts";
import { cSignature, cSourceRules } from "../toolchain/csource.ts";
import { wasmSignature } from "../toolchain/wasm.ts";
import { cDeclarationType, sysvArgumentLocations } from "../toolchain/linker.ts";
import { runtimePromptSection, runtimeRules } from "../runtime/abi.ts";

export interface PromptRequest {
  /** The contract of the function this candidate implements. */
  contract: FunctionContract;
  /**
   * The function this candidate implements, and the file that declares it. A
   * program compiles every function of its contract graph, one at a time, so
   * the function being written is named here rather than taken from the entry.
   */
  unit: { file: string; function: string };
  /**
   * The contract of every file of the program, not only the one being written.
   * A backend is handed the whole program so that no cross-file semantics are
   * left for it to infer, and it may not change any of it.
   */
  program: ProgramContract;
  /** The source each contract was derived from, in program order. */
  sources: readonly SourceModule[];
  target: TargetSpec;
  output: OutputKind;
  runtime: RuntimeKind;
  /** The candidate being produced (1-based). Candidates never share context. */
  candidate: number;
  /** The attempt within that candidate (1-based). The first generates. */
  attempt: number;
  /**
   * The rejected implementation this attempt repairs. Unset on the first
   * attempt of a candidate, which generates from the contract alone.
   */
  previous?: string;
  /**
   * Every diagnostic this candidate collected so far, oldest first. Unset on
   * the first attempt.
   */
  feedback?: string[];
}

const NATIVE_LANGUAGE = "GNU assembler (GAS) AT&T syntax for x86-64";

const NATIVE_RULES = [
  "Emit exactly one global symbol, named by the contract, and nothing else.",
  "Do not emit .section, .arch, .cpu, .file, .include, .incbin, .macro or .rept; the compiler supplies the architecture prelude.",
];

const OUTPUT_LANGUAGE: Record<OutputKind, { language: string; rules: string[] }> = {
  machine: {
    language: NATIVE_LANGUAGE,
    rules: NATIVE_RULES,
  },
  asm: {
    language: NATIVE_LANGUAGE,
    rules: NATIVE_RULES,
  },
  c: {
    language: "C11",
    rules: [
      "Define exactly one function, named and typed as in the signature below, and nothing else: no main, no globals, no helper symbols.",
      cSourceRules,
    ],
  },
  wasm: {
    language: "WebAssembly text format (WAT)",
    rules: [
      "Emit a single module that imports only its linear memory: (import \"env\" \"memory\" (memory 1)).",
      "Export exactly the contracted function, with the signature below. Pointers are i32 byte offsets into the imported memory; the host places the buffers.",
      "Do not import functions, tables or globals, do not export memory or _start, and do not use a start section.",
      "Use only numeric instructions. The module must be self contained.",
    ],
  },
};

const SYSTEM_PROMPT = `You are a native code generation backend.

You generate correct, efficient implementations for one function. The contract
is the authoritative specification of what the function must compute; you are
not trusted to define correctness, and every candidate you produce is validated
by the compiler, which assembles, links and executes it against the contract.

Rules for the implementation you emit:
- Write it in the output language named in the request, and follow the rules
  listed there exactly.
- The architecture prelude, the harness and the build are compiler code. Emit
  only the contracted function.
- Do not write a description of the algorithm outside the code. A short comment
  inside the code is fine.
- Return the code and nothing else.`;

function renderSignature(contract: FunctionContract): string {
  const parameters = contract.function.params.map((param) => `${cDeclarationType(parseType(param.type))} ${param.name}`);
  const returns = cDeclarationType(parseType(contract.function.returns));
  return `${returns} ${contract.function.name}(${parameters.join(", ")})`;
}

function renderMemory(contract: FunctionContract): string {
  const lines: string[] = [];
  lines.push(`reads: ${contract.memory.reads.length === 0 ? "nothing" : contract.memory.reads.join(", ")}`);
  lines.push(`writes: ${contract.memory.writes.length === 0 ? "nothing" : contract.memory.writes.join(", ")}`);
  lines.push(`aliasing: ${contract.memory.aliasing.length === 0 ? "not constrained (the function writes nothing)" : contract.memory.aliasing.join(", ")}`);
  if (contract.memory.alignment !== undefined) {
    lines.push(`alignment: ${JSON.stringify(contract.memory.alignment)}`);
  }
  return lines.join("\n");
}

function renderTypes(contract: FunctionContract): string {
  const entries = contract.function.params.map((param) => {
    const type = parseType(param.type);
    const role = isBufferType(type) ? `buffer of ${typeToString(type.of)}` : "scalar";
    return `${param.name}: ${param.type} (${role})`;
  });
  entries.push(`result: ${contract.function.returns}`);
  return entries.join("\n");
}

/** The whole program: the module being written, and the contract of every other. */
function renderProgram(request: PromptRequest): string {
  const program = request.program;
  const unit = request.unit;
  // The source of the file being written comes first. A program's statements
  // come second, because they are what calls it.
  const written = [unit.file, ...(program.entry.file === unit.file ? [] : [program.entry.file])];
  const lines = [
    `language: ${program.language}`,
    `entry: ${unit.function} in ${unit.file}`,
    ...written.flatMap((path) => {
      const source = request.sources.find((module) => module.path === path);
      return source === undefined ? [] : [`source of ${source.path}:`, "```", source.source.trimEnd(), "```"];
    }),
  ];
  for (const file of program.files.filter((entry) => entry.path !== unit.file)) {
    lines.push(
      `${file.path} exports ${Object.keys(file.functions).join(", ") || "nothing"}${
        file.imports.length === 0 ? "" : `; imports ${file.imports.join(", ")}`
      }`,
    );
    for (const [name, contract] of Object.entries(file.functions)) {
      lines.push(
        `  ${name}(${contract.function.params.map((param) => `${param.name}: ${param.type}`).join(", ")}) -> ${contract.function.returns}`,
        ...contract.requires.map((requirement) => `    requires ${requirement}`),
        ...contract.ensures.map((condition) => `    ensures ${condition}`),
      );
    }
  }
  for (const edge of program.edges) {
    lines.push(`${edge.from} imports ${edge.symbols.join(", ")} from ${edge.to}`);
  }
  return ["PROGRAM", ...lines].join("\n");
}

/** A diagnostic is a multi-line block; a bullet only covers its first line. */
function asBullet(entry: string): string {
  const [head, ...rest] = entry.split("\n");
  return [`- ${head}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

export function buildUserPrompt(request: PromptRequest): string {
  const { contract, target, output, runtime, candidate, attempt, previous, feedback } = request;

  const language = OUTPUT_LANGUAGE[output];
  const native = output === "asm" || output === "machine";
  const locations = sysvArgumentLocations(contract.function.params);
  const rules = output === "wasm" ? language.rules : [...language.rules, ...runtimeRules()];

  const sections: string[] = [];
  sections.push(`CONTRACT\n${JSON.stringify(contract, null, 2)}`);
  sections.push(renderProgram(request));
  sections.push(`TARGET\n${JSON.stringify(target, null, 2)}`);
  if (output !== "wasm") sections.push(`RUNTIME\n${runtimePromptSection(runtime)}`);
  sections.push(["OUTPUT LANGUAGE", `Write ${language.language}.`, ...rules.map((rule) => `- ${rule}`)].join("\n"));
  sections.push(
    [
      "SIGNATURE",
      `C prototype: ${renderSignature(contract)}`,
      ...(native ? [`argument locations: ${locations}`] : []),
      ...(output === "c" ? [`C definition to write: ${cSignature(contract)}`] : []),
      ...(output === "wasm" ? [`WebAssembly signature to export: ${wasmSignature(contract)}`] : []),
      `parameter types:`,
      renderTypes(contract),
    ].join("\n"),
  );
  sections.push(
    [
      "SEMANTIC REQUIREMENTS",
      "The function must satisfy these preconditions on entry:",
      ...contract.requires.map((requirement) => `- ${requirement}`),
      "and must satisfy these postconditions on return:",
      ...contract.ensures.map((condition) => `- ${condition}`),
      "",
      "The postcondition defines the result mathematically. It does not prescribe an algorithm:",
      "summation order, vector width, unrolling and register allocation are yours to choose.",
    ].join("\n"),
  );
  sections.push(["MEMORY REQUIREMENTS", renderMemory(contract)].join("\n"));
  sections.push(
    [
      "NUMERICAL SEMANTICS",
      `floating point: ${contract.numeric.floatingPoint}`,
      `rounding: ${contract.numeric.rounding}`,
      `fast math: ${contract.numeric.fastMath}`,
      contract.numeric.fastMath === false
        ? "Reassociation, contraction and value changes are not allowed; results must be bit-reproducible within the accumulated rounding error of a sequential sum."
        : "Rounding changes are permitted, but the result must still satisfy the postconditions.",
    ].join("\n"),
  );
  sections.push(
    [
      "EFFECTS",
      contract.effects.length === 0
        ? "none: the function is pure and must not perform any I/O or system call"
        : contract.effects.join(", "),
    ].join("\n"),
  );
  sections.push(
    [
      "OPTIMIZATION OBJECTIVE",
      `primary: ${contract.optimize.primary}`,
      `secondary: ${contract.optimize.secondary ?? "none"}`,
      "Optimize for the primary objective while still satisfying every requirement above.",
    ].join("\n"),
  );

  if (previous !== undefined) {
    sections.push(
      [
        `CANDIDATE ${candidate} WAS REJECTED`,
        `This is repair attempt ${attempt}. The compiler assembled, linked and ran the output below and`,
        "rejected it, because of the diagnostics listed after it.",
        "",
        "THE OUTPUT BEING REPAIRED",
        "```",
        previous.trimEnd(),
        "```",

        "DIAGNOSTICS FOR THIS CANDIDATE, OLDEST FIRST",
        ...(feedback === undefined || feedback.length === 0
          ? ["- none were reported for this candidate"]
          : feedback.map(asBullet)),
        "",
        `Repair the whole program: return a complete replacement, not a diff and not an explanation.`,
        `Emit ${language.language} only.`,
      ].join("\n"),
    );
  }

  sections.push(`OUTPUT\n${language.language} only, starting at the first line.`);
  return sections.join("\n\n");
}

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

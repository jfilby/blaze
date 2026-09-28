/**
 * Prompt construction for the AI backend.
 *
 * The prompt states the target, the ABI, the function signature, the semantic
 * and memory requirements, the numerical semantics and the optimization
 * objective. It also states the program the function belongs to: the source of
 * the module being written, the contract of every other file, and the imports
 * between them, so a backend never has to infer a cross-file contract. It
 * never dictates an implementation strategy.
 *
 * Everything the toolchain rejects a candidate for is stated in the prompt
 * rather than left for the candidate to find out: the symbol to define, the
 * labels and the calls a candidate may write, the registers it has to preserve,
 * and what a candidate is checked against. A rule the assembler enforces and
 * the prompt does not state is an attempt the model spends to learn it.
 */

import type {
  FunctionContract,
  OutputKind,
  ProgramContract,
  ProgramMismatch,
  RuntimeKind,
  SourceModule,
  TargetSpec,
} from "../core/types.ts";
import { isBufferType, parseType, symbolOf, typeToString } from "../semantics/contract.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import { calledOut, contractsByName, writtenOut } from "../semantics/calls.ts";
import { cSignature, cSourceRules } from "../toolchain/csource.ts";
import { wasmSignature } from "../toolchain/wasm.ts";
import { cDeclarationType, sysvArgumentLocations, sysvReturnLocation } from "../toolchain/linker.ts";
import { runtimePromptSection, type RuntimeNeeds } from "../runtime/abi.ts";

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
  /**
   * Every function of the program as the IR holds it, by name. This is what a
   * model reads a body from: the resolved, typed, validated program, rather
   * than the source statements it was parsed from.
   */
  semantics: Record<string, SemanticFunction>;
  /** The source each contract was derived from, in program order. */
  sources: readonly SourceModule[];
  target: TargetSpec;
  output: OutputKind;
  runtime: RuntimeKind;
  /** The candidate being produced (1-based). Candidates never share context. */
  candidate: number;
  /** How many candidates this build generates for the function. */
  candidates: number;
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
  /**
   * What the program this function belongs to printed where its source prints
   * something else. A contract that states what a function does has no vector
   * of its own, so the program is the only oracle, and this is what it said.
   */
  programFailure?: ProgramFailure;
}

/**
 * A program that did not print what its source prints, and the answer to fix.
 * A program that printed the wrong line and a program that stopped printing
 * altogether are the same kind of verdict: both are what the function it is
 * the only oracle for has to be regenerated from.
 */
export interface ProgramFailure {
  /** Where the two outputs part: on a line, or at the line the program stopped on. */
  readonly mismatch: ProgramMismatch;
  readonly previous: string;
}

const NATIVE_LANGUAGE = "GNU assembler (GAS) AT&T syntax for x86-64";

/**
 * The rules a machine candidate is held to. What can be read off the text of
 * the candidate is enforced by the assembler before it is run, so a rule left
 * out of that check is an attempt spent learning it from a rejection. The one
 * that is not is register preservation, which only shows up once the candidate
 * is linked and run.
 */
function nativeRules(contract: FunctionContract, plan: CallPlan): string[] {
  const symbol = symbolOf(contract);
  const { called, written } = plan;
  const referenceable = [symbol, ...called.map(symbolOf)].map((name) => `"${name}"`).join(", ");
  return [
    `Declare it with ".global ${symbol}" and define it with the label "${symbol}:", and export nothing else.`,
    'Every other label you define must start with a dot, as in ".Lloop:": a label that is neither the contracted symbol nor a local one is rejected.',
    `The only symbols you may reference are ${referenceable}, and the runtime ABI entry points above.`,
    called.length === 0
      ? "You call no other function of this program, so this candidate is assembled, linked and run on its own, and a fault in it is reported against this function."
      : "The functions listed under CALLS are compiled on their own and linked beside yours, so call them by the symbol given rather than writing out what they do. A candidate that calls one is linked only into the program, which is the only thing that runs it, so nothing here checks it on its own.",
    ...(written.length === 0
      ? []
      : [
          "The functions listed under WRITE OUT are not symbols you may call, and the compiler rejects a",
          "reference to one: what they do is in your prompt, so write each out where your body calls it.",
        ]),
    "It is entered and left as an ordinary System V call, so preserve rbx, rbp and r12 to r15, leave rsp where you found it, and return with ret.",
    "You arrive with the return address still on the stack, so rsp is 8 past a 16-byte boundary, and it has to be back on a 16-byte boundary at every call you make: an allocation that is a multiple of 16 leaves it 8 out, and the runtime you call uses aligned moves on its own frame. Subtract a multiple of 16 plus 8, or realign with \"andq $-16, %rsp\" before the call and put it back after.",
    "The 128 bytes below rsp are yours to use without adjusting it only while you make no calls; a call may use that space for itself.",
    "Do not emit .section, .arch, .cpu, .file, .include, .incbin, .macro or .rept; the compiler supplies the architecture prelude.",
  ];
}

/**
 * What a candidate is told about each function its body reaches: the ones it
 * calls by symbol, and the ones it writes out. The outline has already decided
 * which is which (see semantics/calls.ts), so this reads the contract's own
 * recorded calls rather than judging them here.
 *
 * Both sets follow the bodies written out, not just the candidate's own edges.
 * A body written out lands inside this candidate's object, so a call written
 * inside it is a call this candidate makes: it has to be offered as a symbol
 * with the convention to call it under, or the candidate is shown a body it
 * cannot implement and turned away for implementing it.
 */
interface CallPlan {
  readonly called: readonly FunctionContract[];
  readonly written: readonly FunctionContract[];
}

function callPlan(contract: FunctionContract, program: ProgramContract): CallPlan {
  const contracts = contractsByName(program.files);
  // `writtenOut` leads with the function itself, which is the one being
  // written, and `calledOut` follows the same closure. The two sets are
  // disjoint: a function reached by an edge marked for writing out is a body
  // below, and one reached by an edge marked as a call is a symbol, so nothing
  // is offered as both a body and a call.
  return {
    called: calledOut(contracts, contract).filter((callee) => symbolOf(callee) !== symbolOf(contract)),
    written: writtenOut(contracts, contract).slice(1),
  };
}

/** A callee as a call is written from it: signature, argument locations, result. */
function renderCallable(callee: FunctionContract): string[] {
  return [
    `${symbolOf(callee)}(${callee.function.params.map((param) => `${param.name}: ${param.type}`).join(", ")}) -> ${callee.function.returns}`,
    `  C prototype: ${renderSignature(callee)}`,
    `  argument locations: ${sysvArgumentLocations(callee.function.params)}`,
    `  return value: ${sysvReturnLocation(parseType(callee.function.returns))}`,
  ];
}

/** What a C or WebAssembly candidate is held to. The C compiler and the module checks enforce these. */
const OUTPUT_LANGUAGE: Record<OutputKind, { language: string; rules: string[] }> = {
  machine: { language: NATIVE_LANGUAGE, rules: [] },
  asm: { language: NATIVE_LANGUAGE, rules: [] },
  c: {
    language: "C11",
    rules: [
      "Define exactly one function, named and typed as in the signature below, and nothing else: no main, no globals, no helper symbols.",
      cSourceRules,
    ],
  },
  ir: {
    language: "semantic IR",
    rules: [
      "Answer with the whole function as semantic IR and nothing else: the header lines the compiler printed, then its body, exactly as they are printed above.",
      "The compiler reads it back, checks it against this contract, and writes the target code itself. A register, a stack offset, an instruction, an ABI and a calling convention are yours in neither sense: the IR has no way to say them.",
      "Change the IR, never the contract: the signature, the conditions, the effects, the object layouts and the callee names are the contract's, and the compiler refuses a candidate that disagrees with one of them.",
      "A function whose body you can write as a different sequence of the same IR is a better answer than one you cannot: the IR is what the compiler validates, so an unvalid one is never compiled.",
    ],
  },
  wasm: {
    language: "WebAssembly text format (WAT)",
    rules: [
      'Emit a single module that imports only its linear memory: (import "env" "memory" (memory 1)).',
      "Export exactly the contracted function, with the signature below. Pointers are i32 byte offsets into the imported memory; the host places the buffers.",
      "Do not import functions, tables or globals, do not export memory or _start, and do not use a start section.",
      "Use only numeric instructions. The module must be self contained.",
    ],
  },
};

/**
 * The system prompt, which the output kind decides: a WebAssembly module has
 * no architecture prelude and no harness, so telling a model to leave them
 * alone would be telling it about a build that does not exist.
 */
export function buildSystemPrompt(output: OutputKind): string {
  return [
    "You are a code generation backend.",
    "",
    "You generate correct, efficient implementations for one function. The contract",
    "is the authoritative specification of what the function must compute; you are",
    "not trusted to define correctness, and every candidate you produce is validated",
    "by the compiler, which builds it and runs it against that specification.",
    "",
    "Rules for the implementation you emit:",
    "- Write it in the output language named in the request, and follow the rules",
    "  listed there exactly.",
    ...(output === "wasm" || output === "ir"
      ? []
      : [
          "- The architecture prelude, the harness, the host and the build are compiler",
          "  code. Emit only the contracted function.",
        ]),
    ...(output === "ir"
      ? [
          "- The IR below is the program: it is what the compiler validates and what it",
          "  lowers. Write it as the program you were asked for, and change it as the",
          "  diagnostics below say to.",
        ]
      : []),
    "- Do not write a description of the algorithm outside the code. A short comment",
    "  inside the code is fine.",
    "- Return the code and nothing else, and put nothing else beside it.",
    "",
    "If the contract asks for something you cannot implement at all, do not return",
    "code. Answer with this first line:",
    "",
    "STATUS: failed",
    "",
    "and on the lines after it say what the contract asks for that you cannot do. The",
    "build ends on the first answer like that and asks you nothing further for this",
    "contract, so what you write there is the whole of the report it gets. The status",
    "goes with that explanation and nothing else: never beside code, and never on its",
    "own without saying why."
  ].join("\n");
}

function renderSignature(contract: FunctionContract): string {
  const parameters = contract.function.params.map((param) => `${cDeclarationType(parseType(param.type))} ${param.name}`);
  const returns = cDeclarationType(parseType(contract.function.returns));
  return `${returns} ${contract.function.name}(${parameters.join(", ")})`;
}

function renderMemory(contract: FunctionContract): string {
  const lines: string[] = [];
  lines.push(`reads: ${contract.memory.reads.length === 0 ? "nothing" : contract.memory.reads.join(", ")}`);
  lines.push(`writes: ${contract.memory.writes.length === 0 ? "nothing" : contract.memory.writes.join(", ")}`);
  const aliasing = contract.memory.aliasing;
  const unconstrained =
    contract.memory.writes.length === 0 ? "not constrained (the function writes nothing)" : "not constrained";
  lines.push(`aliasing: ${aliasing.length === 0 ? unconstrained : aliasing.join(", ")}`);
  if (contract.memory.alignment !== undefined) {
    lines.push(`alignment: ${JSON.stringify(contract.memory.alignment)}`);
  }
  return lines.join("\n");
}

/**
 * The parameters as the contract types them, next to what each one is on the
 * wire. A buffer is a bare pointer to its first element: its length is not
 * passed beside it, so it is one of the other parameters, which is why a
 * contract states the length as a precondition.
 */
function renderTypes(contract: FunctionContract): string {
  const entries = contract.function.params.map((param) => {
    const type = parseType(param.type);
    if (!isBufferType(type)) return `${param.name}: ${param.type} (scalar)`;
    return `${param.name}: ${param.type} (buffer of ${typeToString(type.of)}, passed as ${cDeclarationType(type)}, so a bare pointer to the first element; no length arrives with it)`;
  });
  entries.push(`result: ${contract.function.returns}`);
  return entries.join("\n");
}

function renderDefinition(contract: FunctionContract, semantic: SemanticFunction): string {
  const definition = contract.definition;
  if (definition === undefined) return "";
  const lines: string[] = [];
  lines.push("This contract states what the function does, not what it returns:");
  lines.push("there is no postcondition, because the result is not one expression. Implement the body.");
  lines.push("");
  lines.push("WHAT IT DOES");
  lines.push(`allocates objects: ${definition.allocates ? "yes" : "no"}`);
  lines.push(`prints: ${definition.prints ? "yes" : "no"}`);
  lines.push(`reads the command line: ${definition.readsArgv ? "yes" : "no"}`);
  if (definition.objects && Object.keys(definition.objects).length > 0) {
    lines.push("");
    lines.push("OBJECT LAYOUTS");
    for (const object of Object.values(definition.objects)) {
      lines.push(`${object.name}: ${object.size} bytes, align ${object.align}`);
      for (const field of object.fields) {
        lines.push(`  ${field.name}: ${field.type} at offset ${field.offset}`);
      }
    }
    lines.push("");
    // The layouts are the program's objects, and every function is told all
    // of them: one that reads a field needs the offset even though it never
    // builds the object. Only the function that builds one is told how.
    if (definition.allocates) {
      lines.push(
        "Allocate an object with blaze_rt_object_new(bytes, alignment), fill the fields at these offsets, and return the pointer.",
      );
    } else {
      lines.push(
        "This function allocates no object: the layouts above are the ones the program has, and a reference to one is a pointer the program has already given you.",
      );
    }
    lines.push("A null reference is written as a null pointer; every reference is one pointer wide.");
  }
  if (definition.prints) {
    lines.push("");
    lines.push("Print with blaze_rt_print_text for text, blaze_rt_print_number for a number, and blaze_rt_print_newline to end a line.");
  }
  if (definition.readsArgv) {
    lines.push("");
    lines.push("Read the arguments with blaze_rt_argv_count() and blaze_rt_argv(index); an argument that is missing is 0.");
  }
  lines.push("");
  lines.push("HOW YOU ARE CHECKED");
  lines.push(
    "Nothing checks this function on its own. The compiler assembles it, links it with the other",
  );
  lines.push(
    "functions of the program, runs that program, and compares what it prints with what the source",
  );
  lines.push(
    "program prints when it is run on its own toolchain. The two must be the same text, line for line",
  );
  lines.push("and character for character.");
  lines.push(
    "Print every number with blaze_rt_print_number and never format one yourself: it already writes a",
  );
  lines.push(
    "number the way the source language writes one, which is a whole number without a point (70, not",
  );
  lines.push(
    "70.0), the shortest text that reads back as the same value, in full between 1e-6 and 1e21 and in",
  );
  lines.push(
    "exponential form outside that, -0 for a negative zero, and Infinity, -Infinity or NaN for a value",
  );
  lines.push("that is not finite.");
  lines.push("");
  lines.push("NUMBERS");
  lines.push(
    "A number in the source is a double, as it is in the language it was written in, unless a use fixes",
  );
  lines.push(
    "it to something else: passing it to a whole parameter, or storing it in a whole array, declares it",
  );
  lines.push(
    "as one. A whole number the source counts with is whole: a length, a loop index, a shift count, so a",
  );
  lines.push("shift is an integer operation on the count and not a floating point one.");
  lines.push(
    "/ and ** are floating point, because 7 / 2 is 3.5 in the language the source was written in.",
  );
  lines.push(
    "A logical operator is a value and not a condition: a || b is a when a is not 0, and b otherwise.",
  );
  lines.push("");
  lines.push("THE FUNCTION, AS THE COMPILER RESOLVED IT");
  lines.push(
    "This is the whole function: the signature it is called by, what it is held to, and the body",
    "the compiler resolved from its source. Every value below states the type it is and every block",
    "states where control goes, so the behaviour to implement is exactly what is written here.",
  );
  lines.push("```");
  lines.push(printSemanticFunction(semantic));
  lines.push("```");
  return lines.join("\n");
}

/**
 * A callee this candidate is told to write out rather than call: what it does,
 * in the language its source was written in, so the body can be implemented
 * here where the call was. What it is checked by is not restated, because it
 * is not checked on its own here either: the body lands in this candidate, and
 * this candidate is what the program runs.
 */
function renderWrittenOut(callee: FunctionContract, semantic: SemanticFunction | undefined): string[] {
  const signature = `${callee.function.name}(${callee.function.params.map((param) => `${param.name}: ${param.type}`).join(", ")}) -> ${callee.function.returns}`;
  if (semantic !== undefined && semantic.entry !== null) {
    return [`${signature}, contracted by what it does:`, "```", printSemanticFunction(semantic), "```"];
  }
  return [
    `${signature}, which must satisfy:`,
    ...callee.requires.map((requirement) => `  requires ${requirement}`),
    ...callee.ensures.map((condition) => `  ensures ${condition}`),
  ];
}

/**
 * The contract as the model reads it. The body is not in it: the body is
 * rendered from the source above, and carrying the statement tree as well
 * would state it three times over for no gain.
 */
function renderContract(contract: FunctionContract): string {
  const { definition, ...rest } = contract;
  if (definition === undefined) return JSON.stringify(rest, null, 2);
  const { statements, ...whatItDoes } = definition;
  return JSON.stringify({ ...rest, definition: whatItDoes }, null, 2);
}

/**
 * The runtime services a candidate can reach, which is what the ABI section
 * offers it.
 *
 * The needs are this function's own. A function it calls brings its own object
 * and its own needs with it, so they are not this candidate's to carry; a
 * function it writes out is one the outline only marked that way because it
 * allocates nothing, prints nothing and reads no arguments, and so has no
 * needs of its own to carry either. That leaves this body alone, which is
 * where every construct a candidate can reach through is stated.
 *
 * A contract that states a postcondition says nothing about how the work is
 * done, and a library implementation is free to take a working copy of what it
 * is given, so memory is always in reach there.
 */
function runtimeNeeds(request: PromptRequest): RuntimeNeeds {
  const { contract } = request;
  if (isBufferType(parseType(contract.function.returns))) return { memory: true };
  const definition = contract.definition;
  if (definition === undefined) return { memory: true };
  const needs: RuntimeNeeds = {};
  if (definition.allocates) Object.assign(needs, { memory: true, object: true });
  // A function that prints text has to have text to print, and the only way
  // to come by it is a string the runtime builds. Without the memory tag the
  // constructor is filtered out of the ABI section and the prompt is left
  // telling the model to print text it has no way to make.
  if (definition.prints) Object.assign(needs, { output: true, memory: true });
  if (definition.readsArgv) needs.arguments = true;
  return needs;
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
    `function being written: ${unit.function} in ${unit.file}`,
    // The entry is only worth naming when it is not the function in hand: a
    // program compiles every function it exports, one at a time, and only one
    // of them is the entry. A program has no entry function, only the module
    // whose statements the driver runs.
    ...(program.entry.function === null
      ? []
      : program.entry.file === unit.file && program.entry.function === unit.function
        ? []
        : [`program entry: ${program.entry.function} in ${program.entry.file}`]),
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

/**
 * The target, as the machine it has to run on. An empty cpu or feature list
 * means the baseline of the architecture, and nothing says so to a model that
 * would otherwise reach for the widest instruction it knows: one the machine
 * does not implement assembles cleanly and faults the first time it runs.
 */
function renderTarget(target: TargetSpec): string {
  const lines = [
    `architecture: ${target.arch}, operating system: ${target.os}, ABI: ${target.abi}`,
    `instruction set: ${target.features.length === 0 ? `the ${target.arch} baseline, and nothing wider` : target.features.join(", ")}`,
    `cpu selector: ${target.cpu === "" ? "none: the compiler supplies the architecture prelude, so do not select one yourself" : target.cpu}`,
  ];
  return ["TARGET", ...lines].join("\n");
}

/** A diagnostic is a multi-line block; a bullet only covers its first line. */
function asBullet(entry: string): string {
  const [head, ...rest] = entry.split("\n");
  return [`- ${head}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

/** The symbol every output is delivered under, which is not always its name. */
function renderSymbol(contract: FunctionContract, output: OutputKind): string[] {
  const symbol = symbolOf(contract);
  if (output === "c") return [`function to define: ${symbol}`];
  if (output === "wasm") return [`function to export: ${symbol}`];
  return [
    `symbol to define: ${symbol}`,
    `label: ${symbol}:`,
    `directive: .global ${symbol}`,
  ];
}

/**
 * The section that repairs a candidate, which is either a rejection of the
 * candidate against its own contract or the program it belongs to printing
 * something other than what its source prints. The two are told apart, because
 * what the compiler did to reach the verdict is not the same thing.
 */
function renderRepair(request: PromptRequest, language: string): string {
  const { candidate, attempt, previous, feedback, programFailure } = request;
  const failed = programFailure?.previous ?? previous ?? "";
  // A program that stopped is rejected for stopping: the verdict says so, so
  // the repair does not read a line that agrees as a line that disagrees.
  const stopped = programFailure?.mismatch.failure;
  const lines = [
    programFailure === undefined
      ? `CANDIDATE ${candidate} WAS REJECTED`
      : `CANDIDATE ${candidate} WAS REJECTED BY THE PROGRAM IT BELONGS TO`,
    programFailure === undefined
      ? `This is repair attempt ${attempt}. The compiler assembled, linked and ran the output below`
      : `This is repair round ${attempt}. The compiler assembled and linked the output below into the`,
    programFailure === undefined
      ? "against its contract, and rejected it because of the diagnostics listed after it."
      : `program it belongs to, ran that program, and rejected it: ${stopped ?? "the program did not print what the source program prints"}.`,
    programFailure === undefined ? "" : "Nothing runs this function on its own.",
    "",
    "THE OUTPUT BEING REPAIRED",
    "```",
    failed.trimEnd(),
    "```",
  ];
  if (programFailure !== undefined) {
    const { mismatch } = programFailure;
    lines.push(
      "",
      "WHAT THE PROGRAM PRINTED",
      "```",
      mismatch.actualOutput.trimEnd(),
      "```",
      ...(mismatch.failureOutput === undefined
        ? []
        : ["", "WHAT THE PROGRAM WROTE TO STANDARD ERROR", "```", mismatch.failureOutput.trimEnd(), "```"]),
      "",
      "WHAT THE SOURCE PRINTS",
      "```",
      mismatch.expectedOutput.trimEnd(),
      "```",
      "",
      mismatch.failure === undefined
        ? `The outputs are the same until line ${mismatch.line}, where they differ:`
        : `The program stopped before it printed line ${mismatch.line}, so nothing says what it would have printed there:`,
      `  the source prints ${JSON.stringify(mismatch.expected)}`,
      `  the program ${stopped === undefined ? "prints" : "printed"} ${JSON.stringify(mismatch.actual)}`,
    );
  }

  lines.push(
    "",
    "DIAGNOSTICS FOR THIS CANDIDATE, OLDEST FIRST",
    ...(feedback === undefined || feedback.length === 0
      ? ["- none were reported for this candidate"]
      : feedback.map(asBullet)),
    "",
    "A diagnostic listed more than once is one the last repair did not answer: change the approach,",
    "not the line that already failed.",
    "",
    "Repair the whole function: return a complete replacement, not a diff and not an explanation.",
    `Emit ${language} only.`,
  );
  return lines.join("\n");
}

export function buildUserPrompt(request: PromptRequest): string {
  const { contract, target, output, runtime, candidate, candidates, previous, programFailure } = request;

  const language = OUTPUT_LANGUAGE[output];
  const native = output === "asm" || output === "machine";
  // An IR candidate is lowered by the compiler, so the target facts a model needs
  // in order to write machine code — where an argument is, which registers to
  // preserve, how deep a frame is — are facts it is not asked for at all.
  const lowered = output === "ir";
  const semantic = request.semantics[contract.function.name];
  const plan = callPlan(contract, request.program);
  const rules = native ? nativeRules(contract, plan) : language.rules;

  const sections: string[] = [];
  sections.push(`CONTRACT\n${renderContract(contract)}`);
  sections.push(renderProgram(request));
  sections.push(renderTarget(target));
  if (output !== "wasm") sections.push(`RUNTIME\n${runtimePromptSection(runtime, runtimeNeeds(request))}`);
  sections.push(["OUTPUT LANGUAGE", `Write ${language.language}.`, ...rules.map((rule) => `- ${rule}`)].join("\n"));
  sections.push(
    [
      "SIGNATURE",
      ...renderSymbol(contract, output),
      `C prototype: ${renderSignature(contract)}`,
      ...(native
        ? [
            `argument locations: ${sysvArgumentLocations(contract.function.params)}`,
            `return value: ${sysvReturnLocation(parseType(contract.function.returns))}`,
          ]
        : []),
      ...(lowered
        ? ["The compiler lowers this IR to the target, and the target decides where arguments are and which registers a value lives in."]
        : []),
      ...(output === "c" ? [`C definition to write: ${cSignature(contract)}`] : []),
      ...(output === "wasm" ? [`WebAssembly signature to export: ${wasmSignature(contract)}`] : []),
      "parameter types:",
      renderTypes(contract),
    ].join("\n"),
  );
  if (native && plan.called.length > 0) {
    sections.push(
      [
        "CALLS",
        "Each of these is compiled on its own and linked beside yours, so call it instead of writing out",
        "what it does. They are ordinary System V calls, at the locations given:",
        ...plan.called.flatMap((callee) => renderCallable(callee)),
        "The program you are part of is the only thing that runs a candidate that calls one, so nothing",
        "verifies it here and a call that is wrong shows up as the whole program printing something else.",
      ].join("\n"),
    );
  }
  if (native && plan.written.length > 0) {
    sections.push(
      [
        "WRITE OUT",
        "Your body reaches each of these, and each is implemented here rather than called, so their",
        "symbols are not among the ones you may reference. What each one does:",
        ...plan.written.flatMap((callee) => renderWrittenOut(callee, request.semantics[callee.function.name])),
      ].join("\n"),
    );
  }
  sections.push(
    contract.definition === undefined
      ? [
          "SEMANTIC REQUIREMENTS",
          "The function must satisfy these preconditions on entry:",
          ...contract.requires.map((requirement) => `- ${requirement}`),
          "and must satisfy these postconditions on return:",
          ...contract.ensures.map((condition) => `- ${condition}`),
          "",
          "The postcondition defines the result mathematically. It does not prescribe an algorithm:",
          "summation order, vector width, unrolling and register allocation are yours to choose.",
        ].join("\n")
      : ["SEMANTIC REQUIREMENTS", renderDefinition(contract, semantic)].join("\n"),
  );
  // A contract that states what a function does carries no memory ranges and
  // no numeric policy, because a body is not summarized by either. Stating
  // the empty ones would tell a model it reads nothing while its body reads a
  // pointer, and that a summation order is fixed when the body chooses one.
  if (contract.definition === undefined) {
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
  }
  sections.push(
    [
      "EFFECTS",
      ...(contract.effects.length === 0
        ? ["none: the source function touches nothing outside its arguments, and neither may yours"]
        : [
            `the source function: ${contract.effects.join(", ")}`,
            "these are reached through the runtime ABI above and never directly: the output entries",
            "print, and the argument entries read the command line.",
          ]),
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
  // Candidates are generated independently and never see each other, so a
  // second one is only worth its request if it takes a different route.
  if (candidate > 1) {
    sections.push(
      [
        "CANDIDATE",
        `This is candidate ${candidate} of ${candidates}. The candidates of a function are generated`,
        "independently and never see each other, so this one is only worth its request if it takes a",
        "different route: an obvious loop is worth writing once, and vectorising, strength reducing,",
        "unrolling or keeping the working set somewhere else are not the same answer.",
      ].join("\n"),
    );
  }

  if (previous !== undefined || programFailure !== undefined) {
    sections.push(renderRepair(request, language.language));
  }

  sections.push(`OUTPUT\n${language.language} only, starting at the first line.`);
  return sections.join("\n\n");
}

/**
 * The request that follows an answer the compiler could not use.
 *
 * The answer itself is not quoted: there is nothing in it to quote, or the
 * compiler would not be asking again. What is quoted is why it was set aside,
 * so the model answers for that reason rather than repeating itself.
 */
export function buildRetryPrompt(user: string, reasons: readonly string[]): string {
  return [
    user,
    "",
    "THE PREVIOUS ANSWER COULD NOT BE USED",
    "The compiler asked the request above and received answers it could not use:",
    ...reasons.map(asBullet),
    "Nothing was assembled, linked or run, so no diagnostic points at a line of any of them.",
    "",
    "Answer the request above from the beginning: emit the complete implementation as the only",
    "content of the reply, starting at the first line.",
  ].join("\n");
}


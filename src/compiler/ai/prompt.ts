/**
 * Prompt construction for the AI backend.
 *
 * The prompt states the target, the function signature, the semantic and memory
 * requirements, the numerical semantics and the optimization objective. It
 * also states the program the function belongs to: the source of the module
 * being written, the contract of every other file, and the imports between
 * them, so a backend never has to infer a cross-file contract. It never
 * dictates an implementation strategy.
 *
 * The answer is the semantic IR for every output kind, so what the prompt has
 * to state is what a candidate may say, not how to say it in registers: the
 * calls a candidate may write, the object layouts it may hand back, and what
 * a candidate is checked against. A rule the lowering enforces is a rule the
 * model cannot break, so the prompt says nothing about registers, calling
 * conventions or an ABI: those are the compiler's, downstream of the answer.
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
import { cDeclarationType } from "../toolchain/linker.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import { calledOut, contractsByName, writtenOut } from "../semantics/calls.ts";
import { functionOutline, OUTLINE_NOTATION } from "./outline.ts";
import { IR_EXAMPLE, IR_SYNTAX } from "./ir-format.ts";

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
   * Every function of the program as the compiler resolved it, by name. This
   * is what a model reads a body from: the resolved, typed, validated program,
   * rendered as the semantic view in `outline.ts` rather than as the IR the
   * compiler lowers, which is a representation and not a specification.
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


/** A callee as a call is written from it: its contract, and its result. */
function renderCallable(callee: FunctionContract): string[] {
  const parameters = callee.function.params.map((param) => `${param.name}: ${param.type}`);
  return [
    `${callee.function.name}(${parameters.join(", ")}) -> ${callee.function.returns}`,
    ...callee.requires.map((requirement) => `  requires ${requirement}`),
    ...callee.ensures.map((condition) => `  ensures ${condition}`),
  ];
}

/**
 * What a candidate is held to, which is the same for every output kind: the
 * answer is the IR, and the compiler lowers it to whatever the build asked for.
 * A register, a stack offset, an instruction, an ABI and a calling convention
 * are a model's to choose on no kind, because the IR has no way to say them.
 */
const OUTPUT_LANGUAGE = {
  language: "semantic IR",
  rules: [
    "Answer with the whole function as semantic IR, written in the syntax the IR SYNTAX section gives, and nothing else.",
    "The compiler reads it back, checks it against this contract, and writes the target code itself. A register, a stack offset, an instruction, an ABI and a calling convention are yours in neither sense: the IR has no way to say them.",
    "Change the IR, never the contract: the signature, the conditions, the effects, the object layouts and the callee names are the contract's, and the compiler refuses a candidate that disagrees with one of them.",
    "A function whose body you can write as a different sequence of the same IR is a better answer than one you cannot: the IR is what the compiler validates, so an unvalid one is never compiled.",
  ],
};

/**
 * The system prompt, which no longer varies: every build answers in the IR
 * and the compiler writes the target code, so there is no architecture
 * prelude, harness or host for a model to be told to leave alone.
 */
export function buildSystemPrompt(): string {
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
    "- The IR you write is the program: it is what the compiler validates and what",
    "  it lowers to the target. Write it in the syntax the request gives you, for",
    "  the body the request describes, and change it as the diagnostics say to.",
    "- The target code, the build, the harness and the host are compiler code.",
    "  Emit only the contracted function.",
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

/** What the function is: the body the compiler resolved, and how it is reached. */
function renderDefinition(contract: FunctionContract, semantic: SemanticFunction): string {
  const definition = contract.definition;
  const lines: string[] = [];
  lines.push("This is the whole function as the compiler resolved it from the source: the signature it");
  lines.push("is called by, what it does to the world, and the body it runs. Implement this body.");
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
  if (contract.ensures.length > 0) {
    lines.push("The result is checked against the postcondition below, over test vectors the compiler");
    lines.push("builds from the contract and runs your implementation against. The body above is what");
    lines.push("is implemented; the postcondition is what the result is held to.");
  } else {
    lines.push("Nothing checks this function on its own. The compiler assembles it, links it with the");
    lines.push("other functions of the program, runs that program, and");
    lines.push("compares what it prints with what the source program prints when it is run on its own");
    lines.push("toolchain. The two must be the same text, line for line and character for character.");
  }
  if (definition.prints) {
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
  }
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
  lines.push("THE FUNCTION, WITH EVERY VALUE IN THE TYPE THE COMPILER RESOLVED IT TO");
  lines.push(
    "This is the whole function as the compiler resolved it from its source: the signature it is",
    "called by, what it is held to, and the body it runs. Every name states the type it is read",
    "as, so the behaviour to implement is exactly what is written here, and nothing below is a",
    "part of how the compiler represents it.",
  );
  lines.push("");
  lines.push("It is written in this notation:");
  lines.push(...OUTLINE_NOTATION);
  lines.push("");
  lines.push("```");
  lines.push(functionOutline(semantic));
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
  if (semantic === undefined) {
    return [
      `${signature}, which must satisfy:`,
      ...callee.requires.map((requirement) => `  requires ${requirement}`),
      ...callee.ensures.map((condition) => `  ensures ${condition}`),
    ];
  }
  return [`${signature}, as the compiler resolved it:`, "```", functionOutline(semantic), "```"];
}

/**
 * The contract as the model reads it. The body is not in it: the body is
 * written out below, in the form a code generator reads it, and carrying the
 * statement tree as well would state it twice over for no gain.
 */
function renderContract(contract: FunctionContract): string {
  const { statements, ...whatItDoes } = contract.definition;
  return JSON.stringify({ ...contract, definition: whatItDoes }, null, 2);
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
  const { contract, target, candidate, candidates, previous, programFailure } = request;

  const language = OUTPUT_LANGUAGE;
  const semantic = request.semantics[contract.function.name];
  const plan = callPlan(contract, request.program);

  const sections: string[] = [];
  sections.push(`CONTRACT\n${renderContract(contract)}`);
  sections.push(renderProgram(request));
  sections.push(renderTarget(target));
  sections.push(["OUTPUT LANGUAGE", `Write ${language.language}.`, ...language.rules.map((rule) => `- ${rule}`)].join("\n"));
  // A candidate has to be told the form it is answering in, on every kind. The
  // compiler keeps the IR of the function being written to itself: a prompt
  // carrying it would be carrying the answer, so what is stated here is the
  // syntax of the form and a whole function written in it, and nothing of this
  // program.
  sections.push(["IR SYNTAX", ...IR_SYNTAX, "", "A whole function written in it:", "```", IR_EXAMPLE.trimEnd(), "```"].join("\n"));
  // Nothing below tells a candidate where an argument is or which register a
  // value lives in. The compiler writes the target code, and the target decides
  // both, so those are facts the prompt does not carry because nothing asks.
  sections.push(
    ["SIGNATURE", `function to implement: ${symbolOf(contract)}`, "parameter types:", renderTypes(contract)].join("\n"),
  );
  if (plan.called.length > 0) {
    sections.push(
      [
        "CALLS",
        "Each of these is compiled on its own and linked beside yours, so call it by name instead of",
        "writing out what it does. Its contract is:",
        ...plan.called.flatMap((callee) => renderCallable(callee)),
        "The program you are part of is the only thing that runs a candidate that calls one, so nothing",
        "verifies it here and a call that is wrong shows up as the whole program printing something else.",
      ].join("\n"),
    );
  }
  if (plan.written.length > 0) {
    sections.push(
      [
        "WRITE OUT",
        "Your body reaches each of these, and each is implemented here rather than called, so a call to",
        "one is not a call you may make. What each one does:",
        ...plan.written.flatMap((callee) => renderWrittenOut(callee, request.semantics[callee.function.name])),
      ].join("\n"),
    );
  }
  // What the function is, and what it is held to, are two sections: the body is
  // the specification to implement, and the conditions beside it are what the
  // result is checked against afterwards.
  sections.push(["THE FUNCTION TO IMPLEMENT", renderDefinition(contract, semantic)].join("\n"));
  sections.push(
    [
      "WHAT THE RESULT MUST SATISFY",
      "The function must satisfy these preconditions on entry:",
      ...contract.requires.map((requirement) => `- ${requirement}`),
      ...(contract.ensures.length === 0
        ? [
            "There is no postcondition: the result is not one expression, so what the function",
            "returns is checked by running the program and comparing what it prints with what the",
            "source program prints.",
          ]
        : [
            "and these postconditions on return:",
            ...contract.ensures.map((condition) => `- ${condition}`),
            "",
            "The postcondition defines the result mathematically. It does not prescribe an algorithm:",
            "summation order, vector width, unrolling and register allocation are yours to choose.",
          ]),
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
      ...(contract.effects.length === 0
        ? ["none: the source function touches nothing outside its arguments, and neither may yours"]
        : [
            `the source function: ${contract.effects.join(", ")}`,
            "The compiler reaches them through the runtime when it lowers your IR, so state the effect in",
            "the body and the compiler writes the call: printing, the command line, the heap.",
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


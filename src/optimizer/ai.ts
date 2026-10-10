/**
 * AI SDK integration for proposing blaze compiler improvements.
 *
 * Uses the Vercel AI SDK to send compiler source code and context
 * (research papers, build feedback, or neither) to a language model
 * and receive structured code change proposals.
 *
 * Which model is asked, and how a provider is constructed, are the
 * compiler's own: a run asks the model the build it is aimed at would ask,
 * named by the environment or by the project's own selection.
 */

import { generateText } from "ai";
import { languageModelFor } from "../compiler/ai/backend.ts";
import { resolveModel } from "../compiler/ai/model.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectInfo } from "./project.ts";

const COMPILER_DIR = join(import.meta.dirname, "..", "compiler");

/** A single proposed code change. */
export interface Proposal {
  readonly file: string;
  readonly description: string;
  readonly original: string;
  readonly replacement: string;
}

/** The structured response from the AI. */
export interface AiResponse {
  readonly proposals: Proposal[];
  readonly summary: string;
}

/** The three ways a run works. */
export type Method = "research" | "build-feedback" | "code-review";

/** Key compiler source files to include as context. */
const CONTEXT_FILES = [
  "compiler.ts",
  "codegen.ts",
  "semantics/optimize-ir.ts",
  "semantics/repair.ts",
  "ai/review.ts",
  "ai/backend.ts",
  "semantics/parallel.ts",
  "semantics/region.ts",
  "semantics/recursion.ts",
  "semantics/whole-numbers.ts",
];

/** How much of one compiler file is shown. */
const FILE_BUDGET = 24_000;

/** How much compiler source is shown across every file. */
const SOURCE_BUDGET = 96_000;

/** How much of the targeted project's source is shown. */
const PROJECT_SOURCE_SHOWN = 4_000;

/**
 * Read compiler source files and return them as a single context string.
 *
 * @param compilerDir The directory the files are read from, overridable by a
 *   test building its own
 */
export function readCompilerSource(compilerDir = COMPILER_DIR): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of CONTEXT_FILES) {
    const path = join(compilerDir, file);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const full = content.length;
    if (content.length > FILE_BUDGET) {
      content = `${content.slice(0, FILE_BUDGET)}\n// ... ${full - FILE_BUDGET} more characters not shown ...`;
    }
    const block = `// === ${file} ===\n${content}`;
    if (total > 0 && total + block.length > SOURCE_BUDGET) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}

/**
 * The model a run would ask, named the way the environment names it.
 */
export function modelSpec(): string | null {
  const spec = process.env["AI_MODEL"];
  return spec === undefined || spec.trim() === "" ? null : spec.trim();
}

/**
 * The model a run asks: the environment's, or the project's own when the
 * environment names none.
 *
 * A project already knows what it is compiled with, so a run aimed at one
 * asks that when `AI_MODEL` is not set — the same model the build it is
 * aimed at would ask.
 */
export function modelToAsk(project?: ProjectInfo): string | null {
  return modelSpec() ?? project?.model ?? null;
}

/**
 * Why no model could be asked, or null when one could be.
 *
 * Every method proposes through a model, so a session that cannot ask one
 * cannot do anything at all. This is asked before the session does anything,
 * because the answer is the same at the start of a run as it is at the end of
 * one — and finding it out at the end means a baseline suite, a project build
 * and three turns of the loop have been spent learning what a look at the
 * environment says.
 */
export function modelProblem(project?: ProjectInfo): string | null {
  const spec = modelToAsk(project);
  if (spec === null) {
    return project === undefined
      ? "no AI_MODEL is set: it names the provider and the model, as anthropic/claude-sonnet-4-5"
      : `no AI_MODEL is set and ${project.tomlPath} names no model`;
  }
  // The compiler's own resolver is what says whether a spec can be asked: it
  // is the same one a build resolves with, and it names the key that is absent.
  try {
    resolveModel(spec, process.env);
    return null;
  } catch (cause) {
    const error = cause as { message?: string; detail?: string };
    const detail = error.detail === undefined ? "" : ` (${error.detail})`;
    return `the model ${spec} cannot be asked: ${error.message ?? String(cause)}${detail}`;
  }
}

/**
 * Propose compiler improvements using the AI SDK.
 *
 * @param method The way this run works: research, build-feedback or code-review
 * @param context Additional context (research papers or build feedback)
 * @param project The project the run is targeting, if any, whose own model the
 *   run asks when the environment names none
 * @returns The AI's proposals
 */
export async function proposeImprovements(
  method: Method,
  context: string,
  project?: ProjectInfo,
): Promise<AiResponse> {
  const problem = modelProblem(project);
  if (problem !== null) {
    throw new Error(`${problem}.\nSet it in the environment and run blazeopt again.`);
  }

  // The model the compiler would resolve for this run, constructed by the
  // compiler's own provider code rather than by a second copy of it.
  const configuration = resolveModel(modelToAsk(project) ?? "", process.env);
  const model = languageModelFor(configuration);

  const source = readCompilerSource();
  const systemPrompt = buildSystemPrompt(method);
  const userPrompt = buildUserPrompt(method, context, source, project);

  const result = await generateText({
    model,
    instructions: systemPrompt,
    prompt: userPrompt,
  });

  return parseResponse(result.text);
}

function buildSystemPrompt(method: Method): string {
  const methodDesc: Record<Method, string> = {
    "research": "You are given research papers on compiler optimizations and the source code of the blaze compiler.",
    "build-feedback": "You are given AI review feedback from a blaze build and the source code of the blaze compiler.",
    "code-review": "You are given only the source code of the blaze compiler.",
  };

  return `You are a compiler optimization engineer. ${methodDesc[method]}

Your task is to propose specific, actionable code changes that would improve the blaze compiler.

Rules:
- Propose at most 3 changes per pass. Quality over quantity.
- Each change MUST be a search-and-replace operation: you provide the exact original text and the exact replacement text.
- The original text must be a verbatim copy of text that exists in the compiler source.
- The replacement must be complete, valid TypeScript that compiles.
- Focus on correctness, performance, and maintainability improvements.
- Do NOT propose changes to test files.
- Do NOT propose changes that would break the build or tests.

Respond with ONLY a JSON object in this exact format (no markdown fences, no other text):
{
  "summary": "one sentence describing the overall improvement direction",
  "proposals": [
    {
      "file": "relative/path/to/file.ts",
      "description": "what this change does and why it improves the compiler",
      "original": "the exact original text to find (verbatim from the source)",
      "replacement": "the new text to replace it with"
    }
  ]
}`;
}

function buildUserPrompt(
  method: Method,
  context: string,
  source: string,
  project?: ProjectInfo,
): string {
  const parts: string[] = [];

  if (project !== undefined) {
    parts.push("## The project being optimized for\n");
    parts.push(
      "The improvements you propose should be especially relevant to the blaze project " +
        "this run targets. What is known of it:\n",
    );
    parts.push(project.context === "" ? "(no distinctive characteristics were extracted)" : project.context);
    if (project.source.length > 0) {
      const shown = project.source.slice(0, PROJECT_SOURCE_SHOWN);
      const cut = project.source.length > PROJECT_SOURCE_SHOWN ? `\n// ... ${project.source.length - PROJECT_SOURCE_SHOWN} more characters not shown ...` : "";
      parts.push(`\nThe project source (beginning):\n\`\`\`typescript\n${shown}${cut}\n\`\`\``);
    }
    parts.push("");
  }

  if (method === "research") {
    parts.push("## Research Papers\n");
    parts.push("The following research papers are relevant to compiler optimization:\n");
    parts.push(context);
    parts.push("\n");
  } else if (method === "build-feedback") {
    parts.push("## Build AI Review Feedback\n");
    parts.push("The following is AI review feedback from a recent blaze build:\n");
    parts.push(context);
    parts.push("\n");
  }

  parts.push("## Compiler Source\n");
  parts.push("The blaze compiler source code follows. Propose improvements based on the context above (if any) and the code:\n");
  parts.push("```typescript");
  parts.push(source);
  parts.push("```");

  return parts.join("\n");
}

/**
 * Read the JSON answer a model gave back.
 *
 * Thrown when the answer holds no readable JSON object, naming the end of
 * what was read so there is something to change in the next ask.
 */
export function parseResponse(text: string): AiResponse {
  // An answer is read where its JSON object is, wherever the answer wrote
  // it: a fence, a sentence before it, a note after it. Only the outermost
  // braces are taken, so a `{` inside the answer's own text is left alone.
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`the answer held no JSON object: ${tail(trimmed)}`);
  }

  let data: {
    summary?: string;
    proposals?: Array<{
      file?: string;
      description?: string;
      original?: string;
      replacement?: string;
    }>;
  };
  try {
    data = JSON.parse(trimmed.slice(start, end + 1)) as typeof data;
  } catch (cause) {
    throw new Error(
      `the answer's JSON could not be read (${cause instanceof Error ? cause.message : String(cause)}): ${tail(trimmed)}`,
    );
  }

  const proposals: Proposal[] = (data.proposals ?? [])
    .filter(
      (p) =>
        typeof p.file === "string" && p.file !== "" &&
        typeof p.description === "string" && p.description !== "" &&
        typeof p.original === "string" && p.original !== "" &&
        typeof p.replacement === "string",
    )
    .map((p) => ({
      file: p.file!,
      description: p.description!,
      original: p.original!,
      replacement: p.replacement!,
    }));

  return {
    proposals,
    summary: data.summary ?? "No summary provided",
  };
}

/** The end of an answer, for a refusal that says what was read. */
function tail(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `... ${trimmed.slice(-limit)}`;
}

/**
 * What became of one proposal.
 *
 * A proposal is applied verbatim, so every way it can be wrong is a way
 * the compiler's source can be corrupted, and each of them is named rather
 * than counted as one failure.
 */
export type ApplyOutcome =
  | { readonly kind: "applied"; readonly path: string }
  | { readonly kind: "outside-compiler" }
  | { readonly kind: "test-file" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "write-failed"; readonly path: string };

/**
 * Apply a proposal to the compiler source.
 *
 * The file a proposal names is checked before it is read: an answer's text
 * is untrusted input, and a path that leaves the compiler — `../..`, an
 * absolute one — is refused rather than followed. The original text has to
 * appear exactly once, because the first occurrence is not necessarily the
 * one the answer was looking at: this compiler repeats its own scaffolding,
 * and a match written into the wrong copy is a change no test may notice.
 *
 * @param compilerDir The directory the file is read from and written to,
 *   overridable by a test building its own
 */
export function applyProposal(proposal: Proposal, compilerDir = COMPILER_DIR): ApplyOutcome {
  const path = resolveWithinCompiler(proposal.file, compilerDir);
  if (path === null) return { kind: "outside-compiler" };

  // The test suite is the gate a pass is judged by, so a proposal that
  // rewrites it would be judging itself.
  if (/(^|\/)test\//.test(path) || /\.test\.ts$/.test(path)) return { kind: "test-file" };

  let content: string;
  try {
    content = readFileSync(join(compilerDir, path), "utf8");
  } catch {
    return { kind: "not-found" };
  }

  if (proposal.original === "") return { kind: "not-found" };
  const occurrences = content.split(proposal.original).length - 1;
  if (occurrences === 0) return { kind: "not-found" };
  if (occurrences > 1) return { kind: "ambiguous" };
  if (proposal.original === proposal.replacement) return { kind: "unchanged" };

  const updated = content.replace(proposal.original, proposal.replacement);
  try {
    writeFileSync(join(compilerDir, path), updated);
  } catch {
    return { kind: "write-failed", path };
  }
  return { kind: "applied", path };
}

/**
 * The compiler-relative path a proposal may name, or null when it names
 * something that is not a file inside the compiler.
 */
function resolveWithinCompiler(file: string, compilerDir: string): string | null {
  if (file === "" || file.includes("\0")) return null;
  const inside = resolve(compilerDir, file);
  const path = relative(compilerDir, inside);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return null;
  return path;
}

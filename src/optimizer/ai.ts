/**
 * AI SDK integration for proposing blaze compiler improvements.
 *
 * Uses the Vercel AI SDK to send compiler source code and context
 * (research papers, build feedback, or neither) to a language model
 * and receive structured code change proposals.
 */

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** The three pass methods. */
export type PassMethod = "research" | "build-feedback" | "code-review";

/**
 * Resolve the AI model from environment variables.
 * Uses AI_MODEL (e.g. "anthropic/claude-sonnet-4-5") and provider API keys.
 */
function resolveModel() {
  const spec = process.env["AI_MODEL"];
  if (!spec) return undefined;

  const slash = spec.indexOf("/");
  if (slash === -1) return undefined;
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);

  switch (provider) {
    case "anthropic": {
      const apiKey = process.env["ANTHROPIC_API_KEY"] ?? process.env["AI_API_KEY"];
      if (!apiKey) return undefined;
      return createAnthropic({ apiKey })(model);
    }
    case "google": {
      const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? process.env["AI_API_KEY"];
      if (!apiKey) return undefined;
      return createGoogleGenerativeAI({ apiKey })(model);
    }
    case "openai": {
      const apiKey = process.env["OPENAI_API_KEY"] ?? process.env["AI_API_KEY"];
      if (!apiKey) return undefined;
      return createOpenAI({ apiKey })(model);
    }
    case "openai-compatible":
    case "opencode-go": {
      const apiKey = process.env["OPENCODE_API_KEY"] ?? process.env["AI_API_KEY"];
      if (!apiKey) return undefined;
      const baseURL = process.env["AI_BASE_URL"] ?? "https://opencode.ai/zen/go/v1";
      return createOpenAICompatible({ apiKey, baseURL, name: "openai-compatible" })(model);
    }
    case "openrouter": {
      const apiKey = process.env["OPENROUTER_API_KEY"] ?? process.env["AI_API_KEY"];
      if (!apiKey) return undefined;
      const baseURL = "https://openrouter.ai/api/v1";
      return createOpenAICompatible({ apiKey, baseURL, name: "openrouter" })(model);
    }
    default:
      return undefined;
  }
}

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

/** Read compiler source files and return them as a single context string. */
export function readCompilerSource(): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of CONTEXT_FILES) {
    const path = join(COMPILER_DIR, file);
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
 * Propose compiler improvements using the AI SDK.
 *
 * @param method The pass method (research, build-feedback, or code-review)
 * @param context Additional context (research papers or build feedback)
 * @param project The project the run is targeting, if any
 * @returns The AI's proposals
 */
export async function proposeImprovements(
  method: PassMethod,
  context: string,
  project?: ProjectInfo,
): Promise<AiResponse> {
  const model = resolveModel();
  if (!model) {
    throw new Error(
      "No AI model configured. Set AI_MODEL (e.g. anthropic/claude-sonnet-4-5) and the provider's API key.",
    );
  }

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

function buildSystemPrompt(method: PassMethod): string {
  const methodDesc: Record<PassMethod, string> = {
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
  method: PassMethod,
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

function parseResponse(text: string): AiResponse {
  // Strip markdown fences if present
  let clean = text.trim();
  if (clean.startsWith("```")) {
    const firstNewline = clean.indexOf("\n");
    const lastFence = clean.lastIndexOf("```");
    if (firstNewline !== -1 && lastFence > firstNewline) {
      clean = clean.slice(firstNewline + 1, lastFence).trim();
    }
  }

  const data = JSON.parse(clean) as {
    summary?: string;
    proposals?: Array<{
      file?: string;
      description?: string;
      original?: string;
      replacement?: string;
    }>;
  };

  const proposals: Proposal[] = (data.proposals ?? [])
    .filter((p) => p.file && p.description && p.original && p.replacement)
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

/**
 * Apply a proposal to the compiler source.
 * Returns true if the change was applied, false if the original text was not found.
 */
export function applyProposal(proposal: Proposal): boolean {
  const path = join(COMPILER_DIR, proposal.file);
  try {
    const content = readFileSync(path, "utf8");
    if (!content.includes(proposal.original)) {
      return false;
    }
    const updated = content.replace(proposal.original, proposal.replacement);
    writeFileSync(path, updated);
    return true;
  } catch {
    return false;
  }
}

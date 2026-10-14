/**
 * Tavily search integration for compiler optimization research.
 *
 * The optimizer searches for external research on compiler optimizations —
 * either in general or targeted at a specific project — and reads the
 * results as the context of a research pass, so the improvements proposed
 * are grounded in what the papers say rather than in what the model
 * remembers of them.
 *
 *   blazeup                     general compiler optimization research
 *   blazeup [projectPath]       research targeted at a specific project
 *
 * The API key comes from the TAVILY_API_KEY environment variable.
 */

const TAVILY_API_URL = "https://api.tavily.com/search";

/** How long a search may take before it is abandoned, so a search that never
 * answers costs a pass its place in the loop rather than the whole run. */
const SEARCH_TIMEOUT_MS = 60_000;

export interface TavilySearchResult {
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly score: number;
}

export interface TavilyResponse {
  readonly query: string;
  readonly answer?: string;
  readonly results: readonly TavilySearchResult[];
}

/** Thrown when the Tavily API key is missing or the request fails. */
export class TavilyError extends Error {
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "TavilyError";
    this.detail = detail;
  }
}

/**
 * Search for compiler optimization research using Tavily.
 *
 * @param query The search query
 * @param apiKey The Tavily API key (from TAVILY_API_KEY env var)
 * @param maxResults Maximum number of results to return (default 10)
 * @returns The search results
 */
export async function searchTavily(
  query: string,
  apiKey: string,
  maxResults = 10,
): Promise<TavilyResponse> {
  let response: Response;
  try {
    response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "advanced",
        include_answer: true,
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TavilyError(
      `Tavily search failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new TavilyError(
      `Tavily API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  return (await response.json()) as TavilyResponse;
}

/**
 * Read the Tavily API key from the environment.
 * @returns The API key, or undefined if not set
 */
export function tavilyApiKey(): string | undefined {
  return process.env["TAVILY_API_KEY"] || undefined;
}

// ---------------------------------------------------------------------------
// Project context extraction
// ---------------------------------------------------------------------------

/**
 * Extract meaningful context from a project's source file to craft a
 * targeted search query. Looks for function names, common patterns, and
 * the general domain of the program.
 */
export function extractProjectContext(source: string): string {
  const lower = source.toLowerCase();

  // Extract function names — require a parenthesis after the name so that
  // prose like "A function here is given..." doesn't yield "here".
  const functionNames = new Set<string>();
  const funcRegex = /function\s+([a-zA-Z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(source)) !== null) {
    functionNames.add(match[1]);
  }

  // Detect domains
  const domains: string[] = [];
  if (/binary\s+(tree|search)|tree\s+(node|leaf|traversal|walk)|merkle|avl|red.black|bst\b|trie|heapify/.test(lower)) domains.push("tree algorithms");
  if (/sort|merge|quick|heap/.test(lower)) domains.push("sorting");
  if (/matrix|vector|linear|dot\s*product/.test(lower)) domains.push("linear algebra");
  if (/graph|edge|vertex|path|shortest/.test(lower)) domains.push("graph algorithms");
  if (/fibonacci|factorial|fib|recursion|recursive/.test(lower)) domains.push("recursive algorithms");
  if (/hash|map|dictionary|cache/.test(lower)) domains.push("hash-based data structures");
  if (/string|text|parse|token/.test(lower)) domains.push("string processing");
  if (/numerical|compute|calculate|sum|product|integral|derivative/.test(lower)) domains.push("numerical computation");
  if (/array|buffer|element|index/.test(lower)) domains.push("array operations");
  if (/crypto|curve|scalar|point|field|prime|modular|secp|ecdsa|elliptic|signature/.test(lower)) domains.push("elliptic curve cryptography");
  if (/limb|carry|borrow|multi-precision|bigint|wide|double-and-add|modular arithmetic/.test(lower)) domains.push("multi-precision arithmetic");
  if (/floatsub|floatmul|floatdiv|floatadd|floatcmp|fieldadd|fieldmul|fieldsqr|fieldsub|fieldcmp|fieldinv|fielddiv/.test(lower)) domains.push("modular field arithmetic");
  if (/Float64Array|Int32Array|Uint32Array|Uint8Array|Int8Array|Float32Array|Int16Array|Uint16Array|BigInt64Array|BigUint64Array/.test(source)) domains.push("typed array numeric computation");
  if (/fft|convolution|signal|dft|frequency|sample|audio|image|pixel/.test(lower)) domains.push("signal processing");
  if (/compress|decompress|encode|decode|zlib|gzip|lz4|zstd/.test(lower)) domains.push("compression");
  if (/neural|network|layer|weight|gradient|backprop|activation|inference|tensor/.test(lower)) domains.push("neural networks");
  if (/simulat|physics|particle|collision|velocity|force|mass|energy/.test(lower)) domains.push("physics simulation");
  if (/finance|money|currency|interest|payment|trade|stock|option/.test(lower)) domains.push("financial computing");

  // Detect optimization-relevant patterns
  const patterns: string[] = [];
  if (/for\s*\(/.test(source)) patterns.push("loops");
  if (/while\s*\(/.test(source)) patterns.push("iteration");
  if (/\bmap\b|\bfilter\b|\breduce\b/.test(lower)) patterns.push("functional operations");
  if (/Math\.\w+/.test(source)) patterns.push("mathematical builtins");
  if (/new\s+\w+\[/.test(source)) patterns.push("dynamic allocation");
  if (/await\s|async\s/.test(source)) patterns.push("async operations");
  if (/Float64Array/.test(source)) patterns.push("in-place array mutation");
  if (/for\s*\([^)]*--/.test(source) || /for\s*\([^)]*=\s*\w+\s*-\s*\d/.test(source)) patterns.push("reverse iteration");
  if (/carry|borrow/.test(lower)) patterns.push("carry propagation");
  if (/>>|<<|>>>/.test(source)) patterns.push("bit shifts");
  if (/&\s*\d|\|\s*\d|\^\s*\d/.test(source)) patterns.push("bitwise operations");

  const context: string[] = [];
  if (domains.length > 0) context.push(`domains: ${domains.join(", ")}`);
  if (functionNames.size > 0) context.push(`functions: ${[...functionNames].join(", ")}`);
  if (patterns.length > 0) context.push(`patterns: ${patterns.join(", ")}`);

  return context.join("; ");
}

/**
 * Craft a search query for compiler optimization research.
 *
 * @param projectContext Context extracted from the project (or undefined for general search)
 * @returns A search query string
 */
export function craftQuery(projectContext?: string): string {
  const base = "compiler optimization techniques research";
  if (!projectContext) {
    return `${base} 2025 2026 - latest papers and advances`;
  }
  // Extract just the domain part for a cleaner query
  const domainMatch = projectContext.match(/domains:\s*([^;]+)/);
  const domains = domainMatch ? domainMatch[1].trim() : "";
  if (domains) {
    return `${base} for ${domains} - research papers, techniques, and best practices`;
  }
  return `${base} for ${projectContext} - research papers and techniques`;
}

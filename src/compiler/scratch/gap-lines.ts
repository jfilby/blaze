import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { readModuleGraph } from "../semantics/module-graph.ts";
import { readTypeScriptModule, typeScriptFrontend } from "../semantics/typescript.ts";
import { isCompilerError } from "../core/errors.ts";
const ROOT = new URL("..", import.meta.url).pathname;
const NOT = new Set(["node_modules", ".blaze", "test", "bench", "scratch"]);
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (NOT.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}
const paths = await sources(ROOT);
const map = new Map<string, string>();
for (const p of paths) map.set(relative(ROOT, p).split(sep).join("/"), await readFile(p, "utf8"));
const files = [...map.keys()].sort();
const entry = files.includes("cli.ts") ? "cli.ts" : files[0]!;
const records = readModuleGraph({
  frontend: typeScriptFrontend,
  entry: { path: entry, source: map.get(entry) ?? "" },
  roots: files.filter((f) => f !== entry),
  read: (p) => map.get(p) ?? null,
  requireImports: false,
  reader: (source, path, isEntry, context) => {
    try { return readTypeScriptModule(source, path, isEntry, context); }
    catch (error) {
      return { analysis: { path, imports: [], functions: [], default: null, body: [] }, refused: [{ line: 1, message: isCompilerError(error) ? error.message : String(error), detail: "" }], count: 1 };
    }
  },
}).sort((a, b) => (a.path < b.path ? -1 : 1));
let total = 0;
let clean = 0;
const kinds = new Map<string, number>();
for (const record of records) {
  if (record.refused.length === 0 && record.refusedCount === 0) { clean += 1; continue; }
  total += record.refusedCount;
  console.log(`\n${record.path} (${record.refusedCount})`);
  for (const d of record.refused) { console.log(`  line ${d.line}: ${d.message}`); kinds.set(d.message, (kinds.get(d.message) ?? 0) + 1); }
}
console.log(`\n${clean}/${records.length} clean TOTAL ${total}`);
for (const [message, count] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${String(count).padStart(4)} ${message}`);

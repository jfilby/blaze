/** Throwaway: build a program end to end through the CLI and run what it links. */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../core/process.ts";

const CLI = new URL("../cli.ts", import.meta.url).pathname;
const REPLAY = new URL("./fixtures/hello-world-replay.json", import.meta.url).pathname;

const WIDE = ["export function wide(n: u256): u256 {", "  return n;", "}"];

const CASES: Record<string, string> = {
  "legit-add": [
    "export function add(a: u256, b: u256): u256 {",
    "  return a + b;",
    "}",
    "console.log(add(5n, 7n));",
    "console.log(add(1n, 1n) === 2n);",
  ].join("\n"),
  "legit-widen": [...WIDE, "console.log(wide(41n));", "console.log(wide(41n) + 1n);"].join("\n"),
  "wide-neg": ["export function neg(a: u256): u256 {", "  return -a;", "}", "console.log(neg(0n + 5n));"].join("\n"),
  "wide-not": ["export function inv(a: u256): u256 {", "  return ~a;", "}", "console.log(inv(5n));"].join("\n"),
  "wide-mul": [
    "export function times(a: u256, b: u256): u256 {",
    "  return a * b;",
    "}",
    "console.log(times(3n, 4n));",
  ].join("\n"),
  "wide-sub": ["export function sub(a: u256, b: u256): u256 {", "  return a - b;", "}", "console.log(sub(7n, 5n));"].join("\n"),
  "wide-compare-body": [
    ...WIDE,
    "const a = wide(5n);",
    "const b = wide(7n);",
    "console.log(a < b);",
    "console.log(a > b);",
    "console.log(a === 5n);",
    "console.log(a === 7n);",
    "console.log(a <= b);",
    "console.log(a != b);",
  ].join("\n"),
  "wide-shift-body": [...WIDE, "const a = wide(1n);", "console.log(a << 3n);", "console.log(a >> 1n);"].join("\n"),
  "wide-shift-compound": [...WIDE, "const a = wide(1n);", "console.log((a + a) << 2n);"].join("\n"),
  "wide-not-body": [...WIDE, "const a = wide(1n);", "console.log(~a);"].join("\n"),
};

const output = process.argv[2] ?? "machine";
const backend = process.argv[3];

for (const [label, source] of Object.entries(CASES)) {
  const dir = join("/tmp/blaze-e2e", `${label}-${output}-${backend ?? "default"}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "main.ts"), `${source}\n`, "utf8");
  await writeFile(
    join(dir, "blaze.toml"),
    [
      'language = "typescript"',
      'sourceFile = "main.ts"',
      `output = "${output}"`,
      ...(backend ? [`backend = "${backend}"`] : []),
      'mode = "debug"',
      '',
    ].join("\n"),
    "utf8",
  );
  console.log(`\n=== ${label} (${output}/${backend ?? "default"}) ===`);
  const built = await run(process.execPath, [CLI, "build", `--model=replay:${REPLAY}`], {
    cwd: dir,
    timeoutMs: 300_000,
  });
  console.log(`  build exit=${built.code}`);
  if (built.code !== 0) {
    const said = built.stderr.trim().split("\n").filter((l) => !/^\s*$/.test(l)).slice(0, 6);
    console.log("  stderr: " + said.join("\n  "));
    continue;
  }
  const files = await readdir(dir);
  const binary = files.find((f) => !f.endsWith(".ts") && !f.endsWith(".toml") && !f.startsWith("."));
  if (!binary) {
    console.log("  files: " + files.join(" "));
    continue;
  }
  const executed = await run(join(dir, binary), [], { cwd: dir, timeoutMs: 60_000 });
  console.log(`  run exit=${executed.code} out=${JSON.stringify(executed.stdout)}`);
}

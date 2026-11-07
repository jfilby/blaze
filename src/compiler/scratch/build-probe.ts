import { writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { scratch } from "../test/scratch.ts";
import { writeProject } from "../test/project.ts";
const REPLAY = new URL("../test/fixtures/dot-product-replay.json", import.meta.url).pathname;
const directory = await scratch("blaze-probe-");
await writeFile(join(directory, "main.ts"), process.argv[2]!, "utf8");
await writeProject(join(directory, "blaze.toml"), {
  language: "typescript", sourceFile: "main.ts",
  model: { provider: "replay", file: REPLAY }, output: "machine",
  ...(process.env.PROBE_BACKEND === undefined ? {} : { backend: process.env.PROBE_BACKEND as "c" | "machine" }),
});
try {
  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, { stage: () => {} }, "build");
  console.log("built", outcome.build.backend);
  const executed = run(outcome.outputPath as string, [], { timeoutMs: 5000 });
  console.log("exit", executed.code, "out", JSON.stringify(executed.stdout), "err", JSON.stringify(executed.stderr).slice(0, 300));
} catch (error) {
  console.log("FAILED", (error as Error).message.slice(0, 800));
  const detail = (error as { detail?: string }).detail;
  if (detail !== undefined) console.log("DETAIL", detail.slice(0, 600));
  for (const project of await readdir(join(directory, ".blaze/projects")).catch(() => [])) {
    const work = join(directory, ".blaze/projects", project, "work");
    for (const fn of ["start", "f"]) {
      const files = await readdir(join(work, fn)).catch(() => []);
      for (const file of files) {
        if (!file.startsWith("c1.lower.c")) continue;
        console.log(`--- ${fn} ---`);
        console.log((await readFile(join(work, fn, file), "utf8")).split("\n").slice(10, 50).join("\n"));
      }
    }
  }
}

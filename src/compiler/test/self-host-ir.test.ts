/**
 * Resolves every compiler function the way a self-build does.
 *
 * The gap report (self-host.test.ts) checks the frontend: that every source is
 * read into a contract. This check is the next rung: that every contract the
 * frontend produced resolves into IR. It is a fast diagnostic for the self-build
 * — it catches a resolve-time refusal without the ten minutes of candidate
 * generation and verification a full `blaze build` takes — so a slice that
 * breaks one function is visible immediately.
 *
 * The context is the one compiler.ts builds: object names and layouts from the
 * contract phase, and every function keyed by its symbol.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runContractPhase } from "../semantics/program.ts";
import { frontendFor } from "../semantics/frontend.ts";
import { resolveFunction, type FunctionContext } from "../semantics/ir-function.ts";
import type { FunctionContract } from "../core/types.ts";

const root = join(import.meta.dirname ?? ".", "..");
const src = (path: string): string | null => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
};

test("every compiler contract resolves into IR", () => {
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: {
      language: "typescript",
      source: src("cli.ts") ?? "",
      entry: "",
      modules: {
        "#host/model": "ai/review-native.ts",
        "#host/platform": "core/platform-native.ts",
        "#host/toml": "core/toml.ts",
      },
    },
    entry: { path: "cli.ts", source: src("cli.ts") ?? "" },
    read: src,
  });

  const functions: Record<string, FunctionContract> = {};
  for (const file of phase.program.files) {
    for (const contract of Object.values(file.functions)) {
      functions[String(contract.function.symbol)] = contract as FunctionContract;
    }
  }
  const context: FunctionContext = {
    objectNames: phase.objectNames ?? {},
    functions,
    language: "typescript",
  };

  let resolved = 0;
  for (const [name, contract] of Object.entries(functions)) {
    try {
      resolveFunction(contract, context);
      resolved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`${name} does not resolve into IR: ${message}`);
    }
  }
  assert.ok(resolved > 0, "the compiler has contracts to resolve");
});

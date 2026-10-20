/**
 * The rules of a source language, asked of the language.
 *
 * Two languages disagree about a handful of things that are written the same
 * way, and the rules are in one table rather than spread through the resolver.
 * What is tested here is that the same expression under two languages is two
 * answers, and that the table is what says which.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { rulesFor } from "../semantics/language.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";

/** The IR the compiler resolves for one function of one language. */
function irOf(language: string, files: Record<string, string>, entryFile: string, name: string): string {
  const phase = phaseOf(language, files, entryFile);
  const resolved = semanticsOf(phase)[name] as SemanticFunction;
  return printSemanticFunction(resolved);
}

test("the rules of a language are the rules of that language", () => {
  const typescript = rulesFor("typescript");
  assert.equal(typescript.division, "whole");
  assert.equal(typescript.remainder, "truncated");
  assert.equal(typescript.style, "javascript");
  assert.equal(typescript.strictConditions, false);

  const python = rulesFor("python");
  assert.equal(python.division, "true");
  assert.equal(python.remainder, "floored");
  assert.equal(python.style, "python");
  assert.equal(python.strictConditions, true);
});

test("a language the compiler does not read is read as TypeScript", () => {
  assert.equal(rulesFor("cobol").division, rulesFor("typescript").division);
  assert.equal(rulesFor(undefined).division, rulesFor("typescript").division);
});

test("a division of two whole numbers is a whole division in one language and a true division in another", () => {
  const typescript = irOf(
    "typescript",
    {
      "main.ts": [
        "export function identity(x: number): number {",
        "  return x;",
        "}",
        "export function half(x: bigint): bigint {",
        "  return x / 2n;",
        "}",
        "",
      ].join("\n"),
    },
    "main.ts",
    "half",
  );
  const python = irOf(
    "python",
    {
      "main.py": [
        "def identity(x: int) -> int:",
        "    return x",
        "",
        "def half(x: int) -> float:",
        "    return x / 2",
        "",
      ].join("\n"),
    },
    "main.py",
    "half",
  );
  // The TypeScript division of two whole numbers is computed in whole numbers,
  // and the Python one is a fraction however whole its sides were.
  assert.match(typescript, /div\[i64\]/);
  assert.match(python, /div\[f64\]/);
});

test("a remainder takes the sign of its divisor in one language and of its left side in the other", () => {
  const typescript = irOf(
    "typescript",
    {
      "main.ts": [
        "export function identity(x: number): number {",
        "  return x;",
        "}",
        "export function rest(x: number, y: number): number {",
        "  return x % y;",
        "}",
        "",
      ].join("\n"),
    },
    "main.ts",
    "rest",
  );
  const python = irOf(
    "python",
    {
      "main.py": [
        "def identity(x: int) -> int:",
        "    return x",
        "",
        "def rest(x: int, y: int) -> int:",
        "    return x % y",
        "",
      ].join("\n"),
    },
    "main.py",
    "rest",
  );
  assert.match(typescript, /mod\[/);
  assert.match(python, /floorMod\[/);
});

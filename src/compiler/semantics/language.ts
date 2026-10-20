/**
 * The rules of a source language.
 *
 * Two languages disagree about a handful of things that are written the same
 * way. A division of two whole numbers is a whole division in TypeScript and
 * a true division in Python; a remainder takes the sign of its left side in
 * one and of its right side in the other; a number is written as text in a
 * language's own way.
 *
 * Those rules are asked of the language and not of the code that reads them.
 * The resolver reads the language from the program contract and from the
 * function context, so a rule that depends on the language is one place, and
 * a second language costs a second row of the table below rather than a
 * second copy of the arithmetic.
 */

/** How a language writes a value as text. */
export type TextStyle = "javascript" | "python";

/** How a language answers a division of two whole numbers. */
export type DivisionRule = "whole" | "true";

/** How a language answers a remainder. */
export type RemainderRule = "truncated" | "floored";

/**
 * The rules of one source language.
 *
 * A language the compiler does not read has no rules here, and the reader
 * that asks for them is given the rules of the language it knows: a program
 * that was not written in TypeScript is read as if it had been, which is what
 * the compiler did before this table existed.
 */
export interface LanguageRules {
  /** The name the project writes the language by. */
  readonly name: string;
  /** How `a / b` is answered when both sides are whole numbers. */
  readonly division: DivisionRule;
  /** How `a % b` is answered. */
  readonly remainder: RemainderRule;
  /** How a number, a boolean and a null are written as text. */
  readonly style: TextStyle;
  /**
   * Whether a condition has to be a boolean. Python's truth is wider than a
   * boolean — a list of nothing is false and a number that is not a number is
   * true — and the compiler's truth is narrower in the ways that matter, so a
   * Python condition that is not a boolean is refused rather than answered
   * differently.
   */
  readonly strictConditions: boolean;
}

/** The rules of TypeScript, which is what the compiler read before Python. */
const TYPESCRIPT: LanguageRules = {
  name: "typescript",
  division: "whole",
  remainder: "truncated",
  style: "javascript",
  strictConditions: false,
};

/** The rules of Python. */
const PYTHON: LanguageRules = {
  name: "python",
  division: "true",
  remainder: "floored",
  style: "python",
  strictConditions: true,
};

const RULES: Record<string, LanguageRules> = {
  typescript: TYPESCRIPT,
  ts: TYPESCRIPT,
  javascript: TYPESCRIPT,
  js: TYPESCRIPT,
  python: PYTHON,
  py: PYTHON,
};

/**
 * The rules of the language a source is written in.
 *
 * A language the compiler does not read is read as TypeScript, which is what
 * the compiler did before this table existed and what a source of a language
 * that is not read yet is read as.
 */
export function rulesFor(language: string | undefined | null): LanguageRules {
  if (language === undefined || language === null) return TYPESCRIPT;
  const rules = RULES[language.toLowerCase()];
  return rules ?? TYPESCRIPT;
}

/** The names of the languages the compiler reads. */
export const LANGUAGES: readonly string[] = ["typescript", "python"];

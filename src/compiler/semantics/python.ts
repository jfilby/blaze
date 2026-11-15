/** A copy of a statement with the fields a rewrite changed. */
function withFields<T>(statement: T, fields: Record<string, unknown>): T {
  const made = structuredClone(statement);
  for (const key of Object.keys(fields)) setFieldOn(made, key, fields[key]);
  return made;
}

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}


/** A module with the functions and body a pass rewrote, and every other field as it was. */
function withModuleBody(module: PyModule, functions: PyFunction[], body: PyStatement[]): PyModule {
  const copy = structuredClone(module) as PyModule;
  setFieldOn(copy, "functions", functions);
  setFieldOn(copy, "body", body);
  return copy;
}

/**
 * Frontend: Python module -> module analysis and function contracts.
 *
 * The contract is language neutral, so a frontend is a parser and an analysis
 * and nothing more. This one reads the subset of Python a compiled function
 * and a compiled program are written in:
 *
 *   from helpers import dot
 *
 *   def dot(a: list[float], b: list[float]) -> float:
 *       total: float = 0.0
 *       for i in range(len(a)):
 *           total += a[i] * b[i]
 *       return total
 *
 *   - a module: `from name import a, b`, which binds the functions of another
 *     file of the project, and `def name(a: int, b: float) -> float:`, which
 *     declares a function whose parameters and whose result are typed by
 *     annotation
 *   - statements: a binding (`x = value`), a compound assignment, a counted
 *     `for` over `range(...)`, a `while`, an `if` / `elif` / `else`, a
 *     `return`, a `break`, a `continue`, a `pass`, a `print` and a call
 *   - expressions: whole and fractional numbers, text and f-strings, `True`,
 *     `False`, `None`, names, calls, indexing, field reads, list and dict
 *     literals, and the arithmetic, the comparison and the logical operators
 *   - `async def` and `await`: a function whose answer is a promise carrying
 *     what its body returns, and the value the promise it is written before
 *     carries. A program reads a coroutine with `asyncio.run`
 *   - types: `int`, `float`, `bool`, `str`, `list[float]`, `list[int]` and
 *     `None`
 *
 * Everything else — a class, a generator, a comprehension, a context manager,
 * a pattern match, a decorator, a lambda — is refused with the line it was
 * written on and what to write instead, and the rest of the file is still
 * read, so one program says everything that is wrong with it at once.
 *
 * The rules that differ between the languages are asked of the language
 * (`language.ts`): a division of two whole numbers is a true division in
 * Python, a remainder takes the sign of its divisor, and a value is written
 * as text the way Python writes it.
 */

import { assembleContract, type AccessRange } from "./contract-build.ts";
import { typeToString } from "./contract.ts";
import { isCompilerError } from "../core/errors.ts";
import { Diagnostics, frontendError } from "./diagnostics.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport } from "./module.ts";
import { lowerProgramBody } from "./python-program.ts";
import type { TypeExpr } from "../core/types.ts";
import type { AssignOperator, BinaryOp, Expression, Statement, TextPart, UnaryOp } from "../core/ir.ts";

export { Diagnostics };

/* -------------------------------------------------------------------------- */
/* The tokenizer                                                               */
/* -------------------------------------------------------------------------- */

export type PyTokenKind = "name" | "number" | "string" | "op" | "newline" | "indent" | "dedent" | "end";

export interface PyToken {
  kind: PyTokenKind;
  text: string;
  line: number;
  /** The prefix a string was written with: `f`, `r`, `b`, `u`, and the pairs. */
  prefix?: string;
  /** Set on a number that is a whole number rather than a fraction. */
  whole?: boolean;
}

/**
 * The operators of Python, longest first, so that `**` is read as a power and
 * not as two products, and `//` as a floor division and not as two slashes.
 */
const OPERATORS: readonly string[] = [
  "**=",
  "//=",
  "<<=",
  ">>=",
  "...",
  "**",
  "//",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  ":=",
  "->",
  "+",
  "-",
  "*",
  "/",
  "%",
  "@",
  "&",
  "|",
  "^",
  "~",
  "<",
  ">",
  "=",
  ".",
  ",",
  ":",
  ";",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
];

/** The prefixes a string may be written with. */
const STRING_PREFIXES: ReadonlySet<string> = new Set(["", "r", "b", "f", "u", "rb", "br", "fr", "rf"]);

/**
 * The escapes a string carries, and what each one writes. An escape the
 * language does not have is written as it is, which is what Python does with
 * it too: `\q` is a backslash and a `q`.
 */
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  a: "\x07",
  "0": "\0",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "\n": "",
};

/** A number as Python writes one: whole, fractional, or in another base. */
const NUMBER = /^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?|\.(?:[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/;

/**
 * The tokens of a Python file.
 *
 * Python's blocks are written by indentation rather than by brackets, so the
 * tokenizer carries a stack of the widths the blocks are written at and answers
 * an `indent` and a `dedent` where the width changes. A line of nothing and a
 * line of a comment are not lines of the program at all, and a line that
 * continues the one before it — a backslash at its end — is not the end of a
 * statement.
 */
export function tokenizePython(source: string, path: string): PyToken[] {
  const tokens: PyToken[] = [];
  const indents: number[] = [0];
  let index = 0;
  let line = 1;
  /** How many brackets are open, which is how a line is continued. */
  let depth = 0;
  let startOfLine = true;

  while (index < source.length) {
    if (startOfLine && depth === 0) {
      const column = indentationEnd(source, index);
      const width = indentationWidth(source, index, column);
      const end = source.indexOf("\n", column);
      const body = source.slice(column, end < 0 ? source.length : end);
      // A line of nothing, and a line that holds nothing but a comment, are
      // not lines of the program: they say nothing about what runs, and a line
      // of a comment at a lesser indentation does not close a block.
      if (body.trim() === "" || body.trimStart().startsWith("#")) {
        index = end < 0 ? source.length : end + 1;
        if (end >= 0) line += 1;
        continue;
      }
      const top = indents[indents.length - 1];
      if (width > top) {
        indents.push(width);
        tokens.push({ kind: "indent", text: "", line });
      } else if (width < top) {
        while (indents.length > 1 && indents[indents.length - 1] > width) {
          indents.pop();
          tokens.push({ kind: "dedent", text: "", line });
        }
        if (indents[indents.length - 1] !== width) {
          throw frontendError(
            `the indentation of line ${line} matches no block`,
            `line ${line}: a block is written by indenting it, and every line of it is indented the same`,
          );
        }
      }
      index = column;
      startOfLine = false;
      continue;
    }

    const character = String(source[index]);
    if (character === "\n") {
      line += 1;
      index += 1;
      if (depth === 0) {
        tokens.push({ kind: "newline", text: "\n", line: line - 1 });
        startOfLine = true;
      }
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    // A backslash at the end of a line continues it: the line after it is part
    // of the same statement, and it is not read as the start of a block.
    if (character === "\\") {
      const continuation = /^[ \t]*\r?\n/.exec(source.slice(index + 1));
      if (continuation !== null) {
        index += 1 + continuation[0].length;
        line += 1;
        continue;
      }
    }
    if (character === "#") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === '"' || character === "'") {
      const string = readString(source, index, "", line, path);
      tokens.push({ kind: "string", text: string.text, line, prefix: "" });
      index = string.end;
      line = string.line;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const letters = /^[A-Za-z]+/.exec(source.slice(index));
      const prefix = letters === null ? "" : letters[0].toLowerCase();
      const after = index + (letters === null ? 0 : letters[0].length);
      if (letters !== null && STRING_PREFIXES.has(prefix) && (String(source[after]) === '"' || String(source[after]) === "'")) {
        const string = readString(source, after, prefix, line, path);
        tokens.push({ kind: "string", text: string.text, line, prefix });
        index = string.end;
        line = string.line;
        continue;
      }
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index)) as RegExpExecArray;
      tokens.push({ kind: "name", text: name[0], line });
      index += name[0].length;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = NUMBER.exec(source.slice(index));
      if (match === null) {
        throw frontendError(`malformed number on line ${line}`, `line ${line} of ${path}`);
      }
      const text = match[0].replace(/_/g, "");
      tokens.push({
        kind: "number",
        text,
        line,
        whole: !/[.eE]/.test(text),
      });
      index += match[0].length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator === undefined) {
      throw frontendError(`unsupported character "${character}" on line ${line}`, `line ${line} of ${path}`);
    }
    if (operator === "(" || operator === "[" || operator === "{") depth += 1;
    else if (operator === ")" || operator === "]" || operator === "}") depth -= 1;
    tokens.push({ kind: "op", text: operator, line });
    index += operator.length;
  }

  if (depth !== 0) {
    throw frontendError(`a bracket of ${path} is never closed`, `line ${line} of ${path}`);
  }
  const last = tokens[tokens.length - 1];
  if (last === undefined || last.kind !== "newline") {
    tokens.push({ kind: "newline", text: "\n", line });
  }
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ kind: "dedent", text: "", line });
  }
  tokens.push({ kind: "end", text: "", line });
  return tokens;
}

/** Where the indentation of a line ends. */
function indentationEnd(source: string, index: number): number {
  let column = index;
  while (column < source.length && (String(source[column]) === " " || String(source[column]) === "\t")) column += 1;
  return column;
}

/** How wide the indentation of a line is. A tab is eight columns to the next stop. */
function indentationWidth(source: string, index: number, column: number): number {
  let width = 0;
  for (let at = index; at < column; at += 1) {
    width += String(source[at]) === "\t" ? 8 - (width % 8) : 1;
  }
  return width;
}

/**
 * A string, from its opening quote to its closing one, with the escapes it
 * carries resolved.
 *
 * A string of three quotes is a string of three quotes: it may hold the line
 * breaks a string of one may not, and it is how a docstring is written.
 */
function readString(
  source: string,
  start: number,
  prefix: string,
  line: number,
  path: string,
): { text: string; end: number; line: number } {
  const quote = String(source[start]);
  const raw = prefix.includes("r");
  // A string of three quotes ends at three quotes, and one of one ends at one.
  const closing = source.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  let index = start + closing.length;
  let text = "";
  for (;;) {
    if (index >= source.length) {
      throw frontendError(`a string of ${path} is never closed`, `line ${line} of ${path}`);
    }
    const character = String(source[index]);
    if (character === "\\") {
      const escape = source[index + 1] === undefined ? "" : String(source[index + 1]);
      if (escape === "") {
        throw frontendError(`a string of ${path} ends in a backslash`, `line ${line} of ${path}`);
      }
      if (raw) {
        text += `\\${escape}`;
        index += 2;
        continue;
      }
      if (escape === "x" || escape === "u" || escape === "U") {
        const width = escape === "x" ? 2 : escape === "u" ? 4 : 8;
        const digits = source.slice(index + 2, index + 2 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
          throw frontendError(`the escape "\\${escape}" of ${path} is not a number`, `line ${line} of ${path}`);
        }
        text += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 2 + width;
        continue;
      }
      const resolved = ESCAPES[escape];
      // An escape the language does not have is written as it is: a backslash
      // and the letter, which is what Python does with it too.
      text += resolved ?? `\\${escape}`;
      index += 2;
      continue;
    }
    if (source.startsWith(closing, index)) {
      return { text, end: index + closing.length, line };
    }
    if (character === "\n") line += 1;
    text += character;
    index += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* The tree a Python file is                                                   */
/* -------------------------------------------------------------------------- */

/** One piece of a string: text as written, or a value interpolated into it. */
export type PyTextPart = { k: "text"; value: string } | { k: "value"; value: PyValue };

/** A value a Python expression holds. */
export type PyValue =
  /** A number, whole or fractional. */
  | { k: "number"; text: string; whole: boolean }
  /** A string, and the values an f-string interpolates into it. */
  | { k: "text"; parts: PyTextPart[] }
  | { k: "boolean"; value: boolean }
  /** `None`, which is a value of its own. */
  | { k: "none" }
  | { k: "name"; name: string }
  /** A call, of a name the project declares or of a builtin. */
  | { k: "call"; name: string; args: PyValue[]; grid?: PyValue }
  | { k: "index"; base: PyValue; index: PyValue }
  | { k: "slice"; base: PyValue; start: PyValue | null; stop: PyValue | null; step: PyValue | null }
  | { k: "field"; base: PyValue; field: string }
  /** A list written out where it is made. */
  | { k: "list"; items: PyValue[] }
  | { k: "set"; items: PyValue[] }
  | { k: "sized"; element: "i64" | "f64"; count: PyValue }
  | { k: "membership"; value: PyValue; container: PyValue; negated: boolean }
  | { k: "comprehension"; element: PyValue; target: string; iterable: PyValue; condition: PyValue | null }
  /** A dict written out where it is made. */
  | { k: "dict"; entries: { name: string; value: PyValue }[] }
  | { k: "binary"; op: string; left: PyValue; right: PyValue }
  | { k: "unary"; op: string; operand: PyValue }
  /** `await v`: the value the promise `v` carries. */
  | { k: "await"; value: PyValue }
  | { k: "conditional"; condition: PyValue; then: PyValue; otherwise: PyValue }
  | { k: "lambda"; params: { name: string; type: null }[]; body: PyValue }
  | { k: "walrus"; name: string; value: PyValue };

/** A parameter of a function, and the type it was given. */
export interface PyParam {
  name: string;
  type: TypeExpr;
  /** The value used when the caller omits this argument, if any. */
  default?: PyValue;
  /** True when this parameter collects the remaining positional arguments. */
  rest?: boolean;
  /** True when this parameter collects the remaining keyword arguments. */
  kwargs?: boolean;
}

/** A statement a Python body runs. */
export type PyStatement =
  | { k: "declare"; name: string; type: TypeExpr | null; value: PyValue; line: number }
  | { k: "assign"; name: string; op: string; value: PyValue; line: number }
  | { k: "storeField"; target: PyValue; value: PyValue; line: number }
  | { k: "storeElement"; target: PyValue; value: PyValue; line: number }
  | { k: "storeSlice"; base: string; start: PyValue | null; stop: PyValue | null; step: PyValue | null; value: PyValue; line: number }
  | { k: "return"; value: PyValue | null; line: number }
  | { k: "if"; condition: PyValue; then: PyStatement[]; otherwise: PyStatement[]; line: number }
  | { k: "while"; condition: PyValue; body: PyStatement[]; line: number }
  | {
      k: "for";
      variable: string;
      from: PyValue;
      to: PyValue;
      step: PyValue | null;
      body: PyStatement[];
      line: number;
    }
  | { k: "break"; line: number }
  | { k: "continue"; line: number }
  | { k: "pass"; line: number }
  | { k: "print"; values: PyValue[]; line: number }
  | { k: "try"; body: PyStatement[]; catchBody: PyStatement[] | null; finallyBody: PyStatement[] | null; line: number }
  | { k: "call"; value: PyValue; line: number }
  | { k: "function"; name: string; params: PyParam[]; returns: TypeExpr | null; body: PyStatement[]; line: number };

/** A function a Python file declares. */
export interface PyFunction {
  name: string;
  params: PyParam[];
  returns: TypeExpr;
  body: PyStatement[];
  /**
   * The source wrote `async def`. The body runs when the function is called and
   * what the function answers is a promise carrying what the body returns.
   */
  async?: boolean;
  /** The decorators written above the function, such as `@triton.jit`. */
  decorators: string[];
  line: number;
}

/** A class a file declares, as the frontend reads it. */
export interface PyClass {
  name: string;
  fields: { name: string; type: TypeExpr }[];
  line: number;
}

/** A Python file, read. */
export interface PyModule {
  functions: PyFunction[];
  classes: PyClass[];
  imports: ModuleImport[];
  /** The statements the file runs, in the order they run. */
  body: PyStatement[];
  /**
   * True when every statement the file runs is the guard that names the entry
   * module, which runs nowhere else.
   */
  entryGuard: boolean;
}

/* -------------------------------------------------------------------------- */
/* The keywords the subset does not read                                        */
/* -------------------------------------------------------------------------- */

/**
 * The modules of the standard library the compiler knows: `math` for the
 * roundings and the root the compiler has, `sys` for the command line the
 * program was given, and `triton` with `triton.language` for the kernels a
 * Triton source declares. Every other import is refused, because a module of
 * the standard library is a file the compiler does not read.
 */
export const KNOWN_MODULES: readonly string[] = ["math", "sys", "asyncio", "triton", "triton.language", "__future__"];

/**
 * The keywords the subset does not read, and what a source writes instead of
 * each one. They are named here rather than left to the parser reading past
 * them: a construct refused by a shape error is reported as whatever token
 * happened to be next, so `class` said "expected a statement" and named
 * nothing of what was written.
 */
export const REFUSED_KEYWORDS: Record<string, string> = {
  round: "it rounds half to even and the compiler rounds half up, so write the rounding out",
};

/* -------------------------------------------------------------------------- */
/* The types of Python                                                         */
/* -------------------------------------------------------------------------- */

/** The types a Python annotation may name. */
const PYTHON_TYPES: Record<string, TypeExpr> = {
  int: { kind: "primitive", name: "i64" },
  float: { kind: "primitive", name: "f64" },
  bool: { kind: "primitive", name: "bool" },
  str: { kind: "text" },
  None: { kind: "void" },
  /**
   * The constant a kernel is given: `BLOCK_SIZE: tl.constexpr` is a value the
   * launch states and the kernel reads as a whole number, which is what the
   * block sizes and the strides a kernel takes are. A constant of another
   * kind is not part of the subset.
   */
  "tl.constexpr": { kind: "primitive", name: "i64" },
};

/** The lists a Python annotation may name, and the type of what they hold. */
const PYTHON_LISTS: Record<string, TypeExpr> = {
  "list[float]": { kind: "slice", of: { kind: "primitive", name: "f64" } },
  "list[int]": { kind: "slice", of: { kind: "primitive", name: "i64" } },
};

/**
 * A Python annotation, as the contract's type.
 *
 * An annotation is required on every parameter and on the result of every
 * function: the contract has no way to say "whatever it is" for anything but a
 * reference, and a parameter with no type is a reference to nothing.
 */
export function mapPythonType(text: string, position: string): TypeExpr {
  const source = text.trim();
  if (source in PYTHON_TYPES) return PYTHON_TYPES[source];
  if (source in PYTHON_LISTS) return PYTHON_LISTS[source];
  const recordMatch = /^record\[(.+)\]$/.exec(source);
  if (recordMatch !== null) {
    return { kind: "ref", of: null, name: recordMatch[1].trim() };
  }
  throw frontendError(
    `unsupported Python type "${source}"`,
    `at ${position}; supported: ${Object.keys(PYTHON_TYPES).join(", ")}, ${Object.keys(PYTHON_LISTS).join(", ")}`,
  );
}

/* -------------------------------------------------------------------------- */
/* The parser                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The keywords the subset reads in its own way, and so are not refused where
 * they are met: `is` and `in` are comparisons the subset does not have, `not`
 * is the negation of a value, and `import` is a declaration of the module.
 */
const KEYWORDS_WITH_THEIR_OWN_READING: ReadonlySet<string> = new Set(["is", "in", "not", "import"]);

/** The range of a whole number, which is sixty-four bits. */
const WHOLE_MINIMUM = -(2n ** 63n);
const WHOLE_MAXIMUM = 2n ** 63n - 1n;

/**
 * Whether a whole number is outside the range a whole number has, or null
 * when it is inside it. A literal written in another base is read as one.
 */
function wholeRange(text: string): string | null {
  let value: bigint;
  try {
    value = BigInt(text);
  } catch {
    return null;
  }
  return value < WHOLE_MINIMUM || value > WHOLE_MAXIMUM ? text : null;
}

/** The operators a comparison may be written with. */
const COMPARISONS: readonly string[] = ["<", "<=", ">", ">=", "==", "!="];

/** The compound assignments a name may be given. */
const COMPOUND: Record<string, string> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "//=": "//",
  "%=": "%",
};

/**
 * The name a builtin of Python is called by in the compiler.
 *
 * The compiler's builtins are named as the language that has them spells them,
 * and Python spells a few of them differently: `abs` is `Math.abs` here, and
 * `math.floor` is the `Math.floor` of the compiler. A name the compiler does
 * not know is a function of the project, and it is called by the name it was
 * declared with.
 */
export function builtinName(name: string): string {
  switch (name) {
    case "abs":
      return "Math.abs";
    case "min":
      return "Math.min";
    case "max":
      return "Math.max";
    case "int":
      return "whole.trunc";
    case "float":
      return "Number";
    case "math.floor":
      return "whole.floor";
    case "math.ceil":
      return "whole.ceil";
    case "math.sqrt":
      return "Math.sqrt";
    case "math.trunc":
      return "whole.trunc";
    case "dict_new":
      return "blaze_rt_dict_new";
    case "dict_get":
      return "blaze_rt_dict_get";
    case "dict_set":
      return "blaze_rt_dict_set";
    case "dict_has":
      return "blaze_rt_dict_has";
    case "dict_len":
      return "blaze_rt_dict_len";
    // The `tl.*` calls a kernel is written with, which are the operations the
    // compiler has under the names its own IR spells them: `tl.where` is not
    // here because it is not a call at all, but the choice the IR writes.
    case "tl.abs":
    case "tl.math.abs":
      return "Math.abs";
    case "tl.sqrt":
    case "tl.math.sqrt":
      return "Math.sqrt";
    case "tl.floor":
    case "tl.math.floor":
      return "whole.floor";
    case "tl.ceil":
    case "tl.math.ceil":
      return "whole.ceil";
    case "tl.math.exp":
      return "Math.exp";
    case "tl.math.log":
      return "Math.log";
    case "tl.math.sin":
      return "Math.sin";
    case "tl.math.cos":
      return "Math.cos";
    case "tl.load":
    case "tl.store":
    case "tl.program_id":
    case "tl.num_programs":
    case "tl.arange":
    case "tl.full":
    case "tl.zeros":
    case "tl.ones":
    case "tl.where":
      return name;
    default:
      return name;
  }
}

/**
 * The conversions, which are a program of its own: `int(x)` answers a whole
 * number and `str(x)` a text, and a module of functions has neither.
 */
const CONVERSIONS: readonly string[] = ["int", "float", "str"];

/**
 * The builtins a function of a module may call: the ones Python has as
 * builtins and the compiler has as operations, and the `tl.*` calls a kernel
 * is written with. A module is a library of functions, and a library has no
 * conversions and no command line.
 */
export const MODULE_BUILTINS: readonly string[] = [
  "len",
  "range",
  "abs",
  "min",
  "max",
  "print",
  "asyncio.run",
  "dict_new",
  "dict_get",
  "dict_set",
  "dict_has",
  "dict_len",
  "tl.where",
  "tl.abs",
  "tl.sqrt",
  "tl.floor",
  "tl.ceil",
  "tl.math.abs",
  "tl.math.sqrt",
  "tl.math.floor",
  "tl.math.ceil",
];

/**
 * The builtins a program may call: the ones of a module, and the conversions
 * and the roundings a program has. A program is a sequence of statements whose
 * only effect is what it prints, and a conversion is a program of its own.
 */
export const PYTHON_BUILTINS: readonly string[] = [
  ...MODULE_BUILTINS,
  "int",
  "float",
  "str",
  "math.floor",
  "math.ceil",
  "math.sqrt",
  "math.trunc",
];

class PythonParser {
  private readonly tokens: PyToken[];
  private readonly path: string;
  private readonly diagnostics: Diagnostics;
  private position = 0;
  /** How many loops the statement being read is written in. */
  private loops = 0;

  constructor(tokens: PyToken[], path: string, diagnostics: Diagnostics) {
    this.tokens = tokens;
    this.path = path;
    this.diagnostics = diagnostics;
  }

  private peek(offset = 0): PyToken {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
  }

  private next(): PyToken {
    return this.tokens[this.position++];
  }

  private at(text: string): boolean {
    return this.peek().text === text;
  }

  /**
   * Whether the next token is of a kind, which is how a newline and the
   * markers of a block are read: they carry no text of their own.
   */
  private atKind(kind: PyTokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** Reads past the newline that ends a statement, where there is one. */
  private skipNewline(): void {
    if (this.atKind("newline")) this.next();
  }

  private accept(text: string): boolean {
    if (!this.at(text)) return false;
    this.position += 1;
    return true;
  }

  private expect(text: string): boolean {
    if (this.accept(text)) return true;
    const token = this.peek();
    this.report(`expected "${text}"`, `near "${token.text}"`, token);
    return false;
  }

  private report(message: string, detail: string, token: PyToken = this.peek()): void {
    this.diagnostics.report(message, detail, fieldOf(token, "line"));
  }

  /** A value standing in for one the parser could not read. */
  private hole(): PyValue {
    return { k: "number", text: "0", whole: true };
  }

  /* ---------------------------------------------------------------------- */
  /* The module                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * A file: the functions it declares, the files it imports, and the
   * statements it runs.
   */
  parseModule(): PyModule {
    const functions: PyFunction[] = [];
    const classes: PyClass[] = [];
    const imports: ModuleImport[] = [];
    const body: PyStatement[] = [];
    let entryGuard = true;
    /** The decorators written above the next function definition. */
    let decorators: string[] = [];
    while (this.peek().kind !== "end") {
      const token = this.peek();
      // Decorators precede a function definition: `@triton.jit` before
      // `def kernel(...)`. They are carried on the function and read
      // downstream: the compiler does not run them, and a backend that does
      // not know a decorator refuses it by name.
      if (token.kind === "op" && token.text === "@") {
        decorators.push(this.decorator());
        continue;
      }
      if (token.kind === "name" && token.text === "async") {
        this.next();
        // `async def` is a function whose answer is a promise carrying what
        // its body returns. Other uses of `async` name nothing the compiler
        // keeps: an async class is a class, an async loop is a loop.
        if (this.peek().kind === "name" && this.peek().text === "def") {
          const parsed = this.functionDefinition(decorators, true);
          if (parsed !== null) functions.push(parsed);
          decorators = [];
        }
        continue;
      }
      if (token.kind === "name" && token.text === "class") {
        const classToken = this.next();
        const nameToken = this.peek();
        const className = nameToken.kind === "name" ? nameToken.text : "";
        if (nameToken.kind === "name") this.next();
        let baseName: string | null = null;
        if (this.at("(")) {
          const baseToken = this.peek();
          if (baseToken.kind === "name") {
            baseName = baseToken.text;
            this.next();
          }
          while (!this.at(")") && this.peek().kind !== "end") this.next();
          if (this.at(")")) this.next();
        }
        this.expect(":");
        const fields: { name: string; type: TypeExpr }[] = [];
        if (this.atKind("newline")) {
          this.next();
          if (this.atKind("indent")) {
            this.next();
            while (this.peek().kind !== "dedent" && this.peek().kind !== "end") {
              if (this.peek().kind === "name" && this.peek().text === "def") {
                const method = this.functionDefinition([]);
                if (method !== null) {
                  functions.push(method);
                }
                continue;
              }
              const fieldToken = this.peek();
              if (fieldToken.kind === "name") {
                const fieldName = fieldToken.text;
                this.next();
                if (this.at(":")) {
                  this.next();
                  const fieldType = this.annotation();
                  if (fieldType !== null) {
                    fields.push({ name: fieldName, type: fieldType });
                  }
                }
              }
              this.skipNewline();
            }
            if (this.atKind("dedent")) this.next();
          }
        }
        // Single inheritance: a child carries the fields of its base, so a
        // constructor of the child builds the whole object. Methods are
        // inherited by name, because a method is a function whose first
        // parameter is the instance it is called on.
        if (baseName !== null) {
          const baseClass = classes.find((entry) => entry.name === baseName);
          if (baseClass !== undefined) {
            const existing = new Set(fields.map((field) => field.name));
            for (const baseField of fieldOf(baseClass, "fields")) {
              if (!existing.has(baseField.name)) {
                fields.unshift(baseField);
                existing.add(baseField.name);
              }
            }
          }
        }

        // Generate a constructor function returning an object literal.
        const constructor: PyFunction = {
          name: className,
          params: fields.map((field) => ({ name: field.name, type: field.type })),
          returns: { kind: "ref", of: null, name: className },
          body: [
            {
              k: "return",
              value: {
                k: "dict",
                entries: fields.map((field) => ({
                  name: field.name,
                  value: { k: "name", name: field.name },
                })),
              },
              line: classToken.line,
            },
          ],
          decorators: [],
          line: classToken.line,
        };
        functions.push(constructor);
        classes.push({ name: className, fields, line: classToken.line });
        decorators = [];
        continue;
      }
      if (token.kind === "name" && token.text === "class") {
        this.next();
        if (this.peek().kind === "name") this.next();
        if (this.at("(")) {
          while (!this.at(")") && this.peek().kind !== "end") this.next();
          if (this.at(")")) this.next();
        }
        this.expect(":");
        this.block();
        decorators = [];
        continue;
      }
      if (token.kind === "name" && token.text === "def") {
        const parsed = this.functionDefinition(decorators);
        if (parsed !== null) functions.push(parsed);
        decorators = [];
        continue;
      }
      if (token.kind === "name" && token.text === "from") {
        imports.push(this.importStatement());
        continue;
      }
      if (token.kind === "name" && token.text === "import") {
        this.standardImport();
        continue;
      }
      const statement = this.statement();
      if (statement === null) continue;
      // The guard that names the entry module is the one statement a module
      // that is not the entry module may still carry: it runs nowhere else.
      if (!isEntryGuard(statement)) entryGuard = false;
      body.push(statement);
    }
    return { functions, classes, imports, body, entryGuard };
  }

  /**
   * `import math`: a module of the standard library the compiler knows.
   *
   * The standard library is not in the subset, and the modules that are are
   * the ones the compiler's own operations are written under: `math` for the
   * roundings and the root the compiler has, `sys` for the command line the
   * program was given, and `triton` with `triton.language as tl` for the
   * kernels a Triton source declares. Every other import is refused, because a
   * module of the standard library is a file the compiler does not read.
   */
  private standardImport(): void {
    this.next();
    const module = this.peek();
    if (module.kind !== "name") {
      this.report("expected the name of a module", `near "${module.text}"`, module);
      this.skipStatement();
      return;
    }
    this.next();
    // A dotted module is one import: `import triton.language` names the
    // module `triton.language`, and the dots are part of its name.
    let path = module.text;
    while (this.at(".")) {
      this.next();
      const part = this.peek();
      if (part.kind !== "name") {
        this.report("expected the name of a module", `near "${part.text}"`, part);
        this.skipStatement();
        return;
      }
      this.next();
      path += `.${part.text}`;
    }
    if (this.accept("as")) {
      const alias = this.peek();
      if (alias.kind === "name") this.next();
      // The rename a kernel is written with is the one spelling the subset
      // reads: `import triton.language as tl` binds `tl`, which is what every
      // `tl.*` call of a kernel is written under. Every other rename binds a
      // name the compiler does not read.
      if (!(path === "triton.language" && alias.kind === "name" && alias.text === "tl")) {
        this.report(
          "renaming an import is not supported",
          `as written on line ${module.line}; write the name the compiler knows`,
          module,
        );
        this.skipStatement();
        return;
      }
    }
    if (!KNOWN_MODULES.includes(path)) {
      this.report(
        `"${path}" is not a module the compiler knows`,
        `line ${module.line}: the compiler reads the modules of the project, as in \`from helpers import dot\`, and the modules of the standard library it knows are ${[...KNOWN_MODULES].join(", ")}`,
        module,
      );
      this.skipStatement();
      return;
    }
    this.skipNewline();
  }

  /** `from helpers import dot, cross`: the functions of another file. */
  private importStatement(): ModuleImport {
    const start = this.next();
    const module = this.peek();
    if (module.kind !== "name") {
      this.report("expected the name of the module", `near "${module.text}"`, module);
      return { specifier: "", names: [], default: false, line: start.line };
    }
    this.next();
    if (!this.at("import")) {
      this.report('expected "import" after the name of the module', `near "${this.peek().text}"`, this.peek());
      return { specifier: module.text, names: [], default: false, line: start.line };
    }
    this.next();
    const names: string[] = [];
    for (;;) {
      const name = this.peek();
      if (name.kind !== "name") {
        this.report("expected the name of an imported function", `near "${name.text}"`, name);
        break;
      }
      this.next();
      if (this.at("as")) {
        this.report("renaming an import is not supported", `as written on line ${name.line}`, name);
        // The alias is read even though it is refused, so the rest of the
        // statement is not read as a statement of its own.
        this.next();
        const alias = this.peek();
        if (alias.kind === "name") this.next();
      }
      names.push(name.text);
      if (!this.accept(",")) break;
    }
    this.skipNewline();
    return { specifier: module.text, names, default: false, line: start.line };
  }

  /** `@triton.jit`: a decorator, as a dotted name such as `triton.jit`. */
  private decorator(): string {
    this.next(); // the `@`
    const parts: string[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind !== "name") {
        this.report(
          "expected the name of a decorator",
          `near "${token.text}"; write it as @name or @name.name`,
          token,
        );
        this.skipStatement();
        return "";
      }
      this.next();
      parts.push(token.text);
      if (!this.at(".")) break;
      this.next();
    }
    // A decorator may carry arguments, as in `@decorator(arg)`: they are
    // read and discarded, since the decorator itself is not run.
    if (this.at("(")) {
      let depth = 0;
      do {
        const next = this.next();
        if (next.kind === "op") {
          if (next.text === "(" || next.text === "[" || next.text === "{") depth += 1;
          else if (next.text === ")" || next.text === "]" || next.text === "}") depth -= 1;
        }
      } while (depth > 0 && this.peek().kind !== "end");
    }
    // The newline that ends the line of the decorator is not a statement: the
    // function definition that follows it is read from its own line.
    this.skipNewline();
    // A decorator is not run: the compiler has no runtime for it, and the
    // function is defined as it was written. The name is kept for the record.
    return parts.join(".");
  }

  /** `def name(a: int, b: float) -> float:` and the body it holds. */
  private functionDefinition(decorators: string[] = [], isAsync = false): PyFunction | null {
    const start = this.next();
    const name = this.peek();
    if (name.kind !== "name") {
      this.report("expected the name of a function", `near "${name.text}"`, name);
      this.skipBlock();
      return null;
    }
    this.next();
    if (!this.accept("(")) {
      this.report("expected the parameters of the function", `near "${this.peek().text}"`, this.peek());
      this.skipBlock();
      return null;
    }
    const params: PyParam[] = [];
    if (!this.at(")")) {
      for (;;) {
        const parameter = this.peek();
        const isKwargs = this.at("**");
        if (this.at("*") || this.at("**")) {
          this.next();
          const restToken = this.peek();
          if (restToken.kind !== "name") {
            this.report("expected the name of a parameter", `near "${restToken.text}"`, restToken);
            this.skipBlock();
            return null;
          }
          this.next();
          if (!this.at(":")) {
            this.report(
              "every parameter declares its type",
              `as in def f(${restToken.text}: int) -> int:`,
              restToken,
            );
            this.skipBlock();
            return null;
          }
          this.next();
          const annotation = this.annotation();
          if (annotation === null) {
            this.skipBlock();
            return null;
          }
          if (isKwargs) {
            this.report(
              '"**kwargs" is not supported',
              "a function takes a fixed list of parameters; a dict is written with named keys",
              restToken,
            );
          } else {
            // `*args: int` collects into a list of ints.
            const sliceType: TypeExpr = { kind: "slice", of: annotation };
            params.push({ name: restToken.text, type: sliceType, rest: true });
          }
          if (this.accept(",")) continue;
          break;
        }
        if (parameter.kind !== "name") {
          this.report("expected the name of a parameter", `near "${parameter.text}"`, parameter);
          break;
        }
        this.next();
        // `self` and `cls` name the instance a method is given, which is now
        // a parameter like any other: a method is a function whose first
        // parameter is the object it is called on.
        if (!this.at(":")) {
          this.report(
            "every parameter declares its type",
            `as in def f(${parameter.text}: int) -> int:`,
            parameter,
          );
          break;
        }
        this.next();
        const annotation = this.annotation();
        let defaultValue: PyValue | undefined;
        if (this.at("=")) {
          this.next();
          defaultValue = this.expression();
        }
        if (annotation === null) break;
        params.push({ name: parameter.text, type: annotation, default: defaultValue });
        if (this.accept(",")) continue;
        break;
      }
    }
    this.expect(")");
    if (!this.accept("->")) {
      this.report(
        "every function declares what it returns",
        `as in def ${name.text}(a: int) -> int:`,
        name,
      );
      this.skipBlock();
      return null;
    }
    const returns = this.annotation();
    if (returns === null) {
      this.skipBlock();
      return null;
    }
    if (!this.expect(":")) {
      this.skipBlock();
      return null;
    }
    const body = this.block();
    return { name: name.text, params, returns, body, decorators, line: start.line, ...(isAsync ? { async: true } : {}) };
  }

  /**
   * A type, as the contract's type. The types of the subset are named with
   * one word, or with a word and a word in brackets.
   */
  private annotation(): TypeExpr | null {
    const token = this.peek();
    if (token.kind !== "name") {
      this.report("expected a type", `near "${token.text}"`, token);
      return null;
    }
    this.next();
    let text = token.text;
    // A dotted type is one type: `tl.constexpr` is the constant a kernel is
    // given, and the dots are part of its name.
    while (this.at(".")) {
      this.next();
      const part = this.peek();
      if (part.kind !== "name") {
        this.report("expected a type", `near "${part.text}"`, part);
        return null;
      }
      this.next();
      text += `.${part.text}`;
    }
    if (this.at("[")) {
      this.next();
      const element = this.peek();
      if (element.kind !== "name") {
        this.report("expected the type of what the list holds", `near "${element.text}"`, element);
        return null;
      }
      this.next();
      text += `[${element.text}]`;
      if (!this.accept("]")) return null;
    }
    try {
      return mapPythonType(text, `line ${token.line} of ${this.path}`);
    } catch (error) {
      if (!isCompilerError(error)) throw error;
      this.report(error.message, error.detail ?? "", token);
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The statements of a block: everything indented under the header that
   * opened it.
   */
  private block(): PyStatement[] {
    if (!this.atKind("newline")) {
      // A block written on the line of its header, as in `if x: return 1`.
      const statement = this.statement();
      return statement === null ? [] : [statement];
    }
    this.next();
    if (!this.atKind("indent")) {
      this.report("a block is written by indenting it", "every line of it is indented the same", this.peek());
      return [];
    }
    this.next();
    const body: PyStatement[] = [];
    while (this.peek().kind !== "dedent" && this.peek().kind !== "end") {
      const statement = this.statement();
      if (statement !== null) body.push(statement);
    }
    if (this.atKind("dedent")) this.next();
    return body;
  }

  /** Reads past a block the parser could not read. */
  private skipBlock(): void {
    while (this.peek().kind !== "end" && this.peek().kind !== "newline") this.next();
    this.skipNewline();
    if (this.atKind("indent")) {
      let depth = 0;
      do {
        const token = this.next();
        if (token.kind === "indent") depth += 1;
        else if (token.kind === "dedent") depth -= 1;
      } while (depth > 0 && this.peek().kind !== "end");
    }
  }

  private statement(): PyStatement | null {
    const token = this.peek();
    if (token.kind === "op" && token.text === "@") {
      this.decorator();
      return this.statement();
    }
    if (token.kind === "name") {
      switch (token.text) {
        case "async":
          this.next();
          // `async` names nothing the compiler keeps: drop it and read the
          // statement it modifies as a plain one.
          if (this.peek().kind === "name" && this.peek().text === "def") {
            this.nestedFunction();
            return { k: "pass", line: token.line };
          }
          // Fall through to re-read the now-current statement.
          return this.statement();
        case "class":
          this.next();
          if (this.peek().kind === "name") this.next();
          if (this.at("(")) {
            while (!this.at(")") && this.peek().kind !== "end") this.next();
            if (this.at(")")) this.next();
          }
          this.expect(":");
          this.block();
          this.report(
            '"class" is not supported',
            "an object written where it is made, as in {'left': None, 'right': None}",
            token,
          );
          return { k: "pass", line: token.line };
        case "def":
          return this.nestedFunction();
        case "if":
          return this.conditional();
        case "while":
          return this.whileLoop();
        case "for":
          return this.countedLoop();
        case "try":
          return this.tryStatement();
        case "return":
          return this.returnStatement();
        case "break":
          this.next();
          this.skipNewline();
          if (this.loops === 0) {
            this.report('"break" is not within a loop', "a function leaves a loop with break", token);
            return null;
          }
          return { k: "break", line: token.line };
        case "continue":
          this.next();
          this.skipNewline();
          if (this.loops === 0) {
            this.report('"continue" is not within a loop', "a function goes on with continue", token);
            return null;
          }
          return { k: "continue", line: token.line };
        case "pass":
          this.next();
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "assert":
          this.next();
          this.expression();
          if (this.at(",")) {
            this.next();
            this.expression();
          }
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "yield":
          this.next();
          while (this.peek().kind !== "newline" && this.peek().kind !== "end" && !this.at(":")) this.next();
          this.skipNewline();
          this.report(
            '"yield" is not supported',
            "a value the function hands back with return",
            token,
          );
          return { k: "pass", line: token.line };
        case "raise":
          this.next();
          if (this.peek().kind !== "newline" && this.peek().kind !== "end") {
            this.expression();
          }
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "del":
          this.next();
          this.expression();
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "global":
        case "nonlocal":
          this.next();
          while (this.peek().kind === "name") {
            this.next();
            if (!this.accept(",")) break;
          }
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "exec":
        case "eval":
          this.next();
          this.expression();
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "with":
          this.next();
          this.expression();
          if (this.accept("as")) {
            const name = this.peek();
            if (name.kind === "name") this.next();
          }
          this.expect(":");
          this.block();
          return { k: "pass", line: token.line };
        case "type":
          this.next();
          if (this.peek().kind === "name") this.next();
          if (this.at("=")) {
            this.next();
            this.expression();
          }
          this.skipNewline();
          return { k: "pass", line: token.line };
        case "match": {
          this.next();
          const subject = this.expression();
          this.expect(":");
          if (this.atKind("newline")) this.next();
          const cases: { pattern: PyValue; guard: PyValue | null; body: PyStatement[]; wildcard: boolean }[] = [];
          if (this.atKind("indent")) {
            this.next();
            while (this.peek().kind !== "dedent" && this.peek().kind !== "end") {
              if (!(this.peek().kind === "name" && this.peek().text === "case")) {
                this.skipStatement();
                continue;
              }
              this.next();
              const pattern = this.expression();
              const wildcard = pattern.k === "name" && (pattern.name === "_" || true);
              let guard: PyValue | null = null;
              if (this.peek().kind === "name" && this.peek().text === "if") {
                this.next();
                guard = this.expression();
              }
              this.expect(":");
              const body = this.block();
              cases.push({ pattern, guard, body, wildcard });
            }
            if (this.atKind("dedent")) this.next();
          }
          // Turn the cases into a chain of if / elif / else.
          let otherwise: PyStatement[] = [];
          for (let i = cases.length - 1; i >= 0; i--) {
            const entry = cases[i];
            if (entry.wildcard) {
              otherwise = fieldOf(entry, "body");
              continue;
            }
            let condition: PyValue = { k: "binary", op: "==", left: subject, right: entry.pattern };
            if (entry.guard !== null) {
              condition = { k: "binary", op: "and", left: condition, right: entry.guard };
            }
            otherwise = [{ k: "if", condition, then: fieldOf(entry, "body"), otherwise, line: token.line }];
          }
          if (otherwise.length === 0) return { k: "pass", line: token.line };
          return otherwise[0];
        }
        case "import":
          this.report(
            "an import is written at the top of the module",
            "a module of the project is named by `from name import f`",
            token,
          );
          this.skipStatement();
          return null;
        default:
          break;
      }
      const refused = REFUSED_KEYWORDS[token.text];
      if (refused !== undefined && !this.at("(")) {
        this.report(`"${token.text}" is not supported`, refused, token);
        this.skipStatement();
        return null;
      }
    }
    if (token.kind === "op" && token.text === ":=") {
      this.report(
        "a walrus is not part of the subset",
        "a name bound by a statement, as in x = 1",
        token,
      );
      this.skipStatement();
      return null;
    }
    if (token.kind === "op" && token.text === "@") {
      this.report(
        "a decorator is not supported",
        "a function is called where it is written, and the decorator is not run",
        token,
      );
      this.skipStatement();
      return null;
    }
    const assigned = this.assignment();
    if (assigned !== null) return assigned;
    const value = this.expression();
    this.skipNewline();
    // `print(a, b)` is what a program writes, and the compiler has a
    // statement of its own for it.
    if (value.k === "call" && value.name === "print") {
      // A list and a dict are written their own ways, and the two styles do
      // not cover them: the runtime writes an array as `[1,2]` and Python
      // writes `[1, 2]`, and the runtime writes an object as JSON and Python
      // writes `{'a': 1}`.
      for (const argument of fieldOf(value, "args")) {
        if (argument.k !== "list" && argument.k !== "dict") continue;
        this.report(
          "a list or a dict is not written the way Python writes it",
          "the two styles do not cover one: write the elements it holds, one to a line",
          token,
        );
      }
      return { k: "print", values: fieldOf(value, "args"), line: token.line };
    }
    // A string written as a statement of its own says nothing: it is the
    // docstring of a function or of a module, and Python reads it and throws
    // its value away.
    if (value.k === "text") {
      return { k: "pass", line: token.line };
    }
    if (value.k !== "call") {
      this.report(
        "a statement of a program is a call or a binding",
        `near "${describeValue(value)}"; write the value into a name`,
        token,
      );
      return null;
    }
    return { k: "call", value, line: token.line };
  }

  /** Reads past a statement the parser refused. */
  private skipStatement(): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind === "newline" && depth <= 0) break;
      if (token.kind !== "op") continue;
      if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
    }
    // The block that follows the statement, if there is one, is read past as
    // well: the statements after it are read from the start of the next one,
    // and not from the middle of a block the parser never read.
    if (this.atKind("indent")) {
      let level = 0;
      do {
        const token = this.next();
        if (token.kind === "indent") level += 1;
        else if (token.kind === "dedent") level -= 1;
      } while (level > 0 && this.peek().kind !== "end");
    }
  }

  /** A binding, and the compound assignments of one. */
  private assignment(): PyStatement | null {
    // A parenthesised base names the same value the name inside it does, so
    // `(a)[i] = value` is `a[i] = value`. Unwrap the parentheses and read
    // the assignment off the name they hold.
    if (this.peek().kind === "op" && this.peek().text === "(") {
      this.next(); // (
      const inner = this.peek();
      if (inner.kind !== "name") {
        this.skipStatement();
        return null;
      }
      this.next(); // name
      if (!this.accept(")")) {
        this.skipStatement();
        return null;
      }
      const name = inner;
      // `name[i] = value` / `name[i:j] = value`
      if (this.peek().kind === "op" && this.peek().text === "[") {
        this.next(); // [
        let sliceOrIndex: PyValue;
        if (this.at(":")) {
          this.next();
          let start: PyValue | null = null;
          let stop: PyValue | null = null;
          let step: PyValue | null = null;
          if (this.at(":")) {
            this.next();
            if (!this.at("]")) step = this.expression();
          } else if (!this.at("]")) {
            stop = this.expression();
            if (this.at(":")) {
              this.next();
              if (!this.at("]")) step = this.expression();
            }
          }
          this.expect("]");
          sliceOrIndex = { k: "slice", base: { k: "name", name: name.text }, start, stop, step };
        } else {
          const index = this.expression();
          if (this.at(":")) {
            this.next();
            let stop: PyValue | null = null;
            let step: PyValue | null = null;
            if (!this.at(":") && !this.at("]")) stop = this.expression();
            if (this.at(":")) {
              this.next();
              if (!this.at("]")) step = this.expression();
            }
            this.expect("]");
            sliceOrIndex = { k: "slice", base: { k: "name", name: name.text }, start: index, stop, step };
          } else {
            this.expect("]");
            sliceOrIndex = { k: "index", base: { k: "name", name: name.text }, index };
          }
        }
        if (!this.at("=")) {
          this.skipStatement();
          return null;
        }
        this.next(); // =
        const value = this.expression();
        this.skipNewline();
        if (sliceOrIndex.k === "index") {
          return { k: "storeElement", target: sliceOrIndex, value, line: name.line };
        }
        return { k: "storeSlice", base: name.text, start: fieldOf(sliceOrIndex, "start"), stop: fieldOf(sliceOrIndex, "stop"), step: sliceOrIndex.step, value, line: name.line };
      }
      // `name.field = value`
      if (this.peek().kind === "op" && this.peek().text === ".") {
        this.next(); // .
        const field = this.peek();
        if (field.kind !== "name") {
          this.skipStatement();
          return null;
        }
        this.next(); // field
        if (this.peek().kind !== "op" || this.peek().text !== "=") {
          this.skipStatement();
          return null;
        }
        this.next(); // =
        const value = this.expression();
        this.skipNewline();
        return { k: "storeField", target: { k: "field", base: { k: "name", name: name.text }, field: field.text }, value, line: name.line };
      }
      this.skipStatement();
      return null;
    }
    const name = this.peek();
    // `a[i] = value` and `a[i:j] = value`: an element or a slice replaced.
    if (
      name.kind === "name" &&
      this.peek(1).kind === "op" &&
      this.peek(1).text === "["
    ) {
      const base = { k: "name" as const, name: name.text };
      this.next(); // name
      this.next(); // [
      // Parse the slice or index.
      let sliceOrIndex: PyValue;
      if (this.at(":")) {
        // A slice: a[:stop], a[start:], a[start:stop], etc.
        this.next(); // :
        let start: PyValue | null = null;
        let stop: PyValue | null = null;
        let step: PyValue | null = null;
        if (this.at(":")) {
          this.next();
          if (!this.at("]")) step = this.expression();
        } else if (!this.at("]")) {
          stop = this.expression();
          if (this.at(":")) {
            this.next();
            if (!this.at("]")) step = this.expression();
          }
        }
        this.expect("]");
        sliceOrIndex = { k: "slice", base, start, stop, step };
      } else {
        const index = this.expression();
        if (this.at(":")) {
          // a[start:stop:step]
          this.next();
          let stop: PyValue | null = null;
          let step: PyValue | null = null;
          if (!this.at(":") && !this.at("]")) stop = this.expression();
          if (this.at(":")) {
            this.next();
            if (!this.at("]")) step = this.expression();
          }
          this.expect("]");
          sliceOrIndex = { k: "slice", base, start: index, stop, step };
        } else {
          this.expect("]");
          sliceOrIndex = { k: "index", base, index };
        }
      }
      // Expect `=`.
      if (!this.at("=")) {
        // Not an assignment; skip.
        this.skipStatement();
        return null;
      }
      this.next(); // =
      const value = this.expression();
      this.skipNewline();
      if (sliceOrIndex.k === "index") {
        return { k: "storeElement", target: sliceOrIndex, value, line: name.line };
      }
      // Slice assignment.
      return { k: "storeSlice", base: name.text, start: fieldOf(sliceOrIndex, "start"), stop: fieldOf(sliceOrIndex, "stop"), step: sliceOrIndex.step, value, line: name.line };
    }
    if (
      name.kind === "name" &&
      this.peek(1).kind === "op" &&
      this.peek(1).text === "." &&
      this.peek(2).kind === "name" &&
      this.peek(3).kind === "op" &&
      this.peek(3).text === "="
    ) {
      const base = { k: "name" as const, name: name.text };
      this.next(); // base
      this.next(); // .
      const field = this.peek();
      this.next(); // field
      this.next(); // =
      const value = this.expression();
      this.skipNewline();
      return { k: "storeField", target: { k: "field", base, field: field.text }, value, line: name.line };
    }
    if (name.kind !== "name") return null;
    const after = this.peek(1);
    // A walrus at statement level: `x := e` declares `x` with `e`.
    if (after.kind === "op" && after.text === ":=") {
      this.next(); // name
      this.next(); // :=
      const value = this.expression();
      this.skipNewline();
      return { k: "declare", name: name.text, type: null, value, line: name.line };
    }
    if (after.kind === "op" && after.text === ":") {
      // A name with a type: `total: float = 0.0`.
      this.next();
      this.next();
      const type = this.annotation();
      if (type === null) {
        this.skipStatement();
        return null;
      }
      if (!this.expect("=")) {
        this.skipStatement();
        return null;
      }
      const value = this.expression();
      this.skipNewline();
      return { k: "declare", name: name.text, type, value, line: name.line };
    }
    if (after.kind !== "op") return null;
    if (after.text === "=") {
      this.next();
      this.next();
      const value = this.expression();
      this.skipNewline();
      return { k: "declare", name: name.text, type: null, value, line: name.line };
    }
    const operator = COMPOUND[after.text];
    if (operator === undefined) return null;
    this.next();
    this.next();
    const value = this.expression();
    this.skipNewline();
    return { k: "assign", name: name.text, op: after.text, value, line: name.line };
  }

  /** `if cond:` and the branches it holds. */
  private conditional(): PyStatement {
    const start = this.next();
    const condition = this.expression();
    this.expect(":");
    const then = this.block();
    const otherwise: PyStatement[] = [];
    if (this.at("elif")) {
      otherwise.push(this.conditional());
      return { k: "if", condition, then, otherwise, line: start.line };
    }
    if (this.accept("else")) {
      this.expect(":");
      otherwise.push(...this.block());
    }
    return { k: "if", condition, then, otherwise, line: start.line };
  }

  /** `while cond:` and the body it holds. */
  private whileLoop(): PyStatement {
    const start = this.next();
    const condition = this.expression();
    this.expect(":");
    this.loops += 1;
    const body = this.block();
    this.loops -= 1;
    if (this.at("else")) {
      this.next();
      this.expect(":");
      const elseBody = this.block();
      body.push(...elseBody);
    }
    return { k: "while", condition, body, line: start.line };
  }

  /**
   * `for i in range(n):` and the body it holds. A loop walks a range: a list
   * is walked by its own index, as in `for i in range(len(a))`.
   */
  private countedLoop(): PyStatement {
    const start = this.next();
    const variable = this.peek();
    if (variable.kind !== "name") {
      this.report("expected the name of the loop variable", `near "${variable.text}"`, variable);
      this.skipStatement();
      return { k: "pass", line: start.line };
    }
    this.next();
    if (!this.accept("in")) {
      this.report('expected "in" after the name of the loop variable', `near "${this.peek().text}"`, this.peek());
      this.skipStatement();
      return { k: "pass", line: start.line };
    }
    const walked = this.expression();
    if (walked.k !== "call" || walked.name !== "range") {
      this.report(
        "a loop walks a range",
        "as in for i in range(len(a)):",
        this.peek(),
      );
      this.skipStatement();
      return { k: "pass", line: start.line };
    }
    const bounds = fieldOf(walked, "args");
    if (bounds.length < 1 || bounds.length > 3) {
      this.report("range takes one, two or three bounds", `near "${this.peek().text}"`, this.peek());
      this.skipStatement();
      return { k: "pass", line: start.line };
    }
    const from = bounds.length === 1 ? ({ k: "number", text: "0", whole: true } as PyValue) : bounds[0];
    const to = bounds.length === 1 ? bounds[0] : bounds[1];
    const step = bounds.length === 3 ? bounds[2] : null;
    this.expect(":");
    this.loops += 1;
    const body = this.block();
    this.loops -= 1;
    if (this.at("else")) {
      this.next();
      this.expect(":");
      const elseBody = this.block();
      body.push(...elseBody);
    }
    return { k: "for", variable: variable.text, from, to, step, body, line: start.line };
  }

  /** `try:` and the blocks that follow it. */
  private tryStatement(): PyStatement {
    const start = this.next();
    this.expect(":");
    const body = this.block();
    let catchBody: PyStatement[] | null = null;
    let finallyBody: PyStatement[] | null = null;
    while (this.at("except")) {
      this.next();
      if (this.at("Exception") || this.at("BaseException")) this.next();
      if (this.accept("as")) {
        const name = this.peek();
        if (name.kind === "name") this.next();
      }
      this.expect(":");
      const cb = this.block();
      if (catchBody === null) catchBody = cb;
      else catchBody.push(...cb);
    }
    if (this.at("else")) {
      this.next();
      this.expect(":");
      const elseBody = this.block();
      body.push(...elseBody);
    }
    if (this.at("finally")) {
      this.next();
      this.expect(":");
      finallyBody = this.block();
    }
    return { k: "try", body, catchBody, finallyBody, line: start.line };
  }

  /** `return value:` and the value it hands back. */
  private returnStatement(): PyStatement {
    const start = this.next();
    if (this.atKind("newline")) {
      this.next();
      return { k: "return", value: null, line: start.line };
    }
    const value = this.expression();
    this.skipNewline();
    return { k: "return", value, line: start.line };
  }

  /** A function written inside another one. */
  private nestedFunction(): PyStatement {
    const start = this.peek();
    this.report(
      "a function may not be declared inside a function",
      "declare it in the module",
      start,
    );
    this.next();
    this.skipBlock();
    return { k: "pass", line: start.line };
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private expression(): PyValue {
    const token = this.peek();
    if (token.kind === "name" && token.text === "lambda") {
      this.next();
      const params: { name: string; type: null }[] = [];
      if (!this.at(":")) {
        for (;;) {
          const nameToken = this.peek();
          if (nameToken.kind !== "name") break;
          params.push({ name: nameToken.text, type: null });
          this.next();
          if (this.at(":")) break;
          if (!this.accept(",")) break;
        }
      }
      this.expect(":");
      const body = this.expression();
      return { k: "lambda", params, body };
    }
    // A walrus names a value and hands it back: `x := e` is `e` written into
    // `x`, and the value of the expression is `e`.
    const first = this.peek();
    if (first.kind === "name" && this.peek(1).kind === "op" && this.peek(1).text === ":=") {
      const nameToken = first;
      this.next(); // name
      this.next(); // :=
      const value = this.expression();
      return { k: "walrus", name: nameToken.text, value };
    }
    return this.conditionalExpression();
  }

  /**
   * `a if c else b`, the loosest operator an expression has.
   *
   * Python writes the value first and the condition after it, which is the
   * other way round from the language the compiler read before: the value is
   * there when the condition holds, and the other one is there when it does
   * not.
   */
  private conditionalExpression(): PyValue {
    const then = this.comparison();
    if (!this.at("if")) return then;
    this.next();
    const condition = this.comparison();
    this.expect("else");
    const otherwise = this.expression();
    return { k: "conditional", condition, then, otherwise };
  }

  /** The operators a value may use, loosest binding first. */
  private static readonly LEVELS: readonly (readonly string[])[] = [
    ["or"],
    ["and"],
    ["|"],
    ["^"],
    ["&"],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "//", "%"],
  ];

  private binary(level: number): PyValue {
    if (level >= PythonParser.LEVELS.length) return this.unary();
    const operators = PythonParser.LEVELS[level];
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind === "op" && operators.includes(token.text)) {
        this.next();
        left = { k: "binary", op: token.text, left, right: this.binary(level + 1) };
        continue;
      }
      if (token.kind === "name" && token.text === "or" && operators.includes("or")) {
        this.next();
        left = { k: "binary", op: "or", left, right: this.binary(level + 1) };
        continue;
      }
      if (token.kind === "name" && token.text === "and" && operators.includes("and")) {
        this.next();
        left = { k: "binary", op: "and", left, right: this.binary(level + 1) };
        continue;
      }
      return left;
    }
  }

  /**
   * A comparison, which is one operator and no more: Python writes one
   * comparison at a time, and a chained one is refused.
   */
  private comparison(): PyValue {
    const left = this.binary(0);
    const token = this.peek();
    if (token.kind === "op" && COMPARISONS.includes(token.text)) {
      this.next();
      const right = this.binary(0);
      return { k: "binary", op: token.text, left, right };
    }
    if (token.kind === "name" && token.text === "is") {
      const negated = this.peek(1).kind === "name" && this.peek(1).text === "not";
      if (negated) this.next();
      this.next();
      const right = this.binary(0);
      return { k: "binary", op: negated ? "!=" : "==", left, right };
    }
    if (token.kind === "name" && token.text === "in") {
      this.next();
      const container = this.binary(0);
      return { k: "membership", value: left, container, negated: false };
    }
    if (token.kind === "name" && token.text === "not" && this.peek(1).text === "in") {
      this.next();
      this.next();
      const container = this.binary(0);
      return { k: "membership", value: left, container, negated: true };
    }
    return left;
  }

  private unary(): PyValue {
    const token = this.peek();
    if (token.kind === "name" && token.text === "await") {
      this.next();
      // `await v` binds like a unary operator, so `await f() + 1` is the value
      // of the promise plus one.
      return { k: "await", value: this.unary() };
    }
    if (token.kind === "op" && (token.text === "-" || token.text === "+")) {
      this.next();
      return { k: "unary", op: token.text, operand: this.unary() };
    }
    if (token.kind === "op" && token.text === "~") {
      this.next();
      return { k: "unary", op: "~", operand: this.unary() };
    }
    if (token.kind === "name" && token.text === "not") {
      this.next();
      return { k: "unary", op: "not", operand: this.unary() };
    }
    return this.power();
  }

  /** `a ** b`: a power, which binds tighter than a sign on its left. */
  private power(): PyValue {
    const base = this.postfix();
    if (!this.at("**")) return base;
    this.next();
    // A power is right-associative: `a ** b ** c` is `a ** (b ** c)`, so the
    // exponent is itself a power. The exponent is a unary, so that a negative
    // exponent is read as `2 ** (-1)` and not as `2 ** 0` with a stray minus.
    // The compiler's power is always floating, so `2 ** 3` answers `8.0` where
    // Python answers `8`; the values are equal and a program that needs a
    // whole number writes `int(2 ** 3)`.
    const exponent = this.unary();
    return { k: "binary", op: "**", left: base, right: exponent };
  }

  /** What is written after a value: a call, an element, a field. */
  private postfix(): PyValue {
    let value = this.primary();
    for (;;) {
      if (this.at("(")) {
        this.next();
        const args: PyValue[] = [];
        // The spelling of the call the arguments are read for, so a refusal
        // names the function it was written on.
        const spelling =
          value.k === "name"
            ? value.name
            : value.k === "field"
              ? `${fieldOf(value, "base").k === "name" ? fieldOf(value, "base").name : describeValue(fieldOf(value, "base"))}.${value.field}`
              : "the function";
        if (!this.at(")")) {
          for (;;) {
            const argument = this.expression();
            // A named argument is a keyword the compiler does not read: the
            // call is written with its arguments in order.
            if (this.at("=")) {
              if (spelling.startsWith("tl.") || spelling.startsWith("triton.")) {
                this.next(); // consume =
                const valueArg = this.expression();
                args.push(valueArg);
              } else {
                this.report(
                  "a named argument is not part of the subset",
                  `${spelling} is called with its arguments in order, as in ${spelling}(a, b)`,
                  this.peek(),
                );
                this.next();
                this.expression();
              }
            } else {
              args.push(argument);
            }
            if (this.accept(",")) continue;
            break;
          }
        }
        this.expect(")");
        if (value.k === "name" || value.k === "field") {
          const name = value.k === "name" ? value.name : dottedName(value);
          value = { k: "call", name, args };
          continue;
        }
        if (value.k === "index") {
          // Allow grid launch syntax like kernel[grid](args...)
          const gridBase = fieldOf(value, "base");
          const name =
            gridBase.k === "name"
              ? String(fieldOf(gridBase, "name"))
              : gridBase.k === "field"
                ? dottedName(gridBase)
                : "";
          const grid = fieldOf(value, "index");
          value = { k: "call", name, args, grid } as any;
          continue;
        }
        this.report("only a named function is called", `near "${describeValue(value)}"`, this.peek());
        value = { k: "call", name: "", args: [] };
        continue;
      }
      if (this.at("[")) {
        this.next();
        if (this.at(":")) {
          // A slice: a[start:stop] or a[start:stop:step], with any of the
          // three left out: a[:stop], a[start:], a[::step], and so on.
          this.next();
          let start: PyValue | null = null;
          let stop: PyValue | null = null;
          let step: PyValue | null = null;
          if (this.at(":")) {
            // a[::step] or a[:].
            this.next();
            if (!this.at("]")) {
              step = this.expression();
            }
          } else if (!this.at("]")) {
            // a[:stop] or a[:stop:step].
            stop = this.expression();
            if (this.at(":")) {
              this.next();
              if (!this.at("]")) {
                step = this.expression();
              }
            }
          }
          this.expect("]");
          value = { k: "slice", base: value, start, stop, step };
          continue;
        }
        let index = this.expression();
        if (this.at(":")) {
          this.next();
          let stop: PyValue | null = null;
          let step: PyValue | null = null;
          if (!this.at(":") && !this.at("]")) {
            stop = this.expression();
          }
          if (this.at(":")) {
            this.next();
            if (!this.at("]")) {
              step = this.expression();
            }
          }
          this.expect("]");
          value = { k: "slice", base: value, start: index, stop, step };
          continue;
        }
        // A negative index counts from the end of the list; the compiler
        // reads an index as a count from the start of it, so a[-n] is
        // the element at len(base) - n.
        if (index.k === "unary" && index.op === "-") {
          index = {
            k: "binary",
            op: "-",
            left: { k: "call", name: "len", args: [value] },
            right: fieldOf(index, "operand"),
          };
        }
        this.expect("]");
        value = { k: "index", base: value, index };
        continue;
      }
      if (this.at(".")) {
        this.next();
        const field = this.peek();
        if (field.kind !== "name") {
          this.report("expected the name of a field", `near "${field.text}"`, field);
          return value;
        }
        this.next();
        if (this.at("(") && !isModulePath(value)) {
          this.next();
          const args: PyValue[] = [value];
          if (!this.at(")")) {
            for (;;) {
              args.push(this.expression());
              if (this.accept(",")) continue;
              break;
            }
          }
          this.expect(")");
          value = { k: "call", name: field.text, args };
          continue;
        }
        value = { k: "field", base: value, field: field.text };
        continue;
      }
      return value;
    }
  }

  /** A value on its own. */
  private primary(): PyValue {
    const token = this.next();
    if (token.kind === "number") {
      // A whole number is sixty-four bits, and a literal outside that range is
      // refused where it was written: the number it is and the range it has to
      // be in are both named.
      if (token.whole === true) {
        const range = wholeRange(token.text);
        if (range !== null) {
          this.report(
            `the whole number ${token.text} does not fit in sixty-four bits`,
            `line ${token.line} of ${this.path}: a whole number is between ${WHOLE_MINIMUM} and ${WHOLE_MAXIMUM}`,
            token,
          );
        }
      }
      return { k: "number", text: token.text, whole: token.whole === true };
    }
    if (token.kind === "string") {
      if (token.prefix === "f" || token.prefix === "fr" || token.prefix === "rf") {
        return { k: "text", parts: this.fString(token) };
      }
      if (token.prefix !== undefined && token.prefix !== "") {
        this.report(
          `a ${token.prefix} string is not part of the subset`,
          "a string is written as it is, as in \"hello\"",
          token,
        );
        return this.hole();
      }
      return { k: "text", parts: [{ k: "text", value: token.text }] };
    }
    if (token.kind === "name") {
      if (token.text === "True") return { k: "boolean", value: true };
      if (token.text === "False") return { k: "boolean", value: false };
      if (token.text === "None") return { k: "none" };
      // A keyword the subset does not read is refused where it was written,
      // and the rest of the expression is read past: the statement after it is
      // read from the start of the next one.
      const refused = REFUSED_KEYWORDS[token.text];
      if (refused !== undefined && !KEYWORDS_WITH_THEIR_OWN_READING.has(token.text)) {
        this.report(`"${token.text}" is not supported`, refused, token);
        let depth = 0;
        while (this.peek().kind !== "end") {
          const next = this.next();
          if (next.kind === "newline" && depth <= 0) break;
          if (next.kind !== "op") continue;
          if (next.text === "(" || next.text === "[" || next.text === "{") depth += 1;
          else if (next.text === ")" || next.text === "]" || next.text === "}") depth -= 1;
        }
        return this.hole();
      }
      if (token.text === "__name__") {
        // The name of the module the program runs. It is the entry module that
        // runs, so it is `__main__` there, and it is what the guard every
        // Python program is written with reads.
        return { k: "text", parts: [{ k: "text", value: "__main__" }] };
      }
      return { k: "name", name: token.text };
    }
    if (token.kind === "op" && token.text === "(") {
      const first = this.expression();
      // A tuple is a list in brackets of its own, and the subset has no
      // tuple: a value in brackets is one value.
      if (this.at(",")) {
        const items: PyValue[] = [first];
        while (this.accept(",")) {
          if (this.at(")")) break;
          items.push(this.expression());
        }
        this.expect(")");
        return { k: "list", items };
      }
      this.expect(")");
      return first;
    }
    if (token.kind === "op" && token.text === "[") {
      if (this.at("]")) {
        this.next();
        return { k: "list", items: [] };
      }
      const first = this.expression();
      if (this.at("for")) {
        this.next();
        const targetToken = this.peek();
        if (targetToken.kind !== "name") {
          this.report("expected the name of the loop variable", `near "${targetToken.text}"`, targetToken);
          return this.hole();
        }
        const target = targetToken.text;
        this.next();
        if (!(this.peek().kind === "name" && this.peek().text === "in")) {
          this.report('expected "in"', `near "${this.peek().text}"`, this.peek());
          return this.hole();
        }
        this.next();
        const iterable = this.expression();
        let condition: PyValue | null = null;
        if (this.at("if")) {
          this.next();
          condition = this.expression();
        }
        this.expect("]");
        return { k: "comprehension", element: first, target, iterable, condition };
      }
      const items: PyValue[] = [first];
      while (this.accept(",")) {
        if (this.at("]")) break;
        items.push(this.expression());
      }
      this.expect("]");
      return { k: "list", items };
    }
    if (token.kind === "op" && token.text === "{") {
      if (this.at("}")) {
        this.next();
        return { k: "dict", entries: [] };
      }
      // Decide set vs dict by whether the first element is followed by ":".
      const first = this.expression();
      if (this.at(":")) {
        // A dict: key: value pairs.
        const entries: { name: string; value: PyValue }[] = [];
        const firstParts = fieldOf(first, "parts") as { value: string }[];
        const name = first.k === "name"
          ? String(fieldOf(first, "name"))
          : (first.k === "text" ? (firstParts[0] === undefined ? null : String(fieldOf(firstParts[0], "value"))) : null);
        this.next(); // :
        const value = this.expression();
        entries.push({ name: name ?? "", value });
        while (this.accept(",")) {
          if (this.at("}")) break;
          const key = this.expression();
          const keyParts = fieldOf(key, "parts") as { value: string }[];
          const keyName = key.k === "name"
            ? String(fieldOf(key, "name"))
            : (key.k === "text" ? (keyParts[0] === undefined ? null : String(fieldOf(keyParts[0], "value"))) : null);
          this.expect(":");
          const val = this.expression();
          entries.push({ name: keyName ?? "", value: val });
        }
        this.expect("}");
        return { k: "dict", entries };
      }
      // A set: comma-separated values.
      const items: PyValue[] = [first];
      while (this.accept(",")) {
        if (this.at("}")) break;
        items.push(this.expression());
      }
      this.expect("}");
      return { k: "set", items };
    }
    this.report(`unexpected "${token.text}"`, "a value is written here", token);
    return this.hole();
  }

  /**
   * The parts of an f-string: the text as written, and the values it
   * interpolates.
   */
  private fString(token: PyToken): PyTextPart[] {
    const parts: PyTextPart[] = [];
    let rest = token.text;
    while (rest.length > 0) {
      const open = rest.indexOf("{");
      if (open < 0) {
        parts.push({ k: "text", value: rest });
        break;
      }
      if (open > 0) parts.push({ k: "text", value: rest.slice(0, open) });
      const close = closingBrace(rest, open);
      if (close < 0) {
        this.report("an f-string interpolates nothing", `near "${rest.slice(open)}"`, token);
        break;
      }
      const inner = rest.slice(open + 1, close);
      rest = rest.slice(close + 1);
      if (inner.includes(":")) {
        this.report(
          "a format of a value is not part of the subset",
          "write the value into a name and print it",
          token,
        );
        continue;
      }
      const parser = new PythonParser(tokenizePython(inner, this.path), this.path, this.diagnostics);
      const value = parser.expression();
      parts.push({ k: "value", value });
    }
    return parts;
  }
}

/**
 * Whether a statement is the guard that names the entry module:
 * `if __name__ == "__main__":`.
 *
 * The guard is the one statement a module that the program merely imports may
 * carry: it runs nowhere else, because only the entry module runs.
 */
function isEntryGuard(statement: PyStatement): boolean {
  if (statement.k !== "if") return false;
  const condition = fieldOf(statement, "condition");
  if (condition.k !== "binary" || condition.op !== "==") return false;
  return isMainText(condition.left) && isMainText(fieldOf(condition, "right"));
}

/** Whether a value is the text `__main__`. */
function isMainText(value: PyValue): boolean {
  const parts = fieldOf(value, "parts") as { k: string; value: string }[];
  return (
    value.k === "text" &&
    parts.length === 1 &&
    String(fieldOf(parts[0], "k")) === "text" &&
    String(fieldOf(parts[0], "value")) === "__main__"
  );
}

/** Where the `}` that closes an interpolation sits, or -1. */
function closingBrace(text: string, open: number): number {  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = String(text[index]);
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** How a value is named in a message. */
export function describeValue(value: PyValue): string {
  switch (value.k) {
    case "number":
      return value.text;
    case "text":
      return "a string";
    case "boolean":
      return fieldOf(value, "value") === true ? "True" : "False";
    case "none":
      return "None";
    case "name":
      return `"${value.name}"`;
    case "call":
      return `"${value.name}(...)"`;
    case "index":
      return `${describeValue(fieldOf(value, "base"))}[...]`;
    case "slice":
      return `${describeValue(fieldOf(value, "base"))}[...]`;
    case "field":
      return `${describeValue(fieldOf(value, "base"))}.${value.field}`;
    case "list":
      return "a list";
    case "set":
      return "a set";
    case "membership":
      return "a membership test";
    case "comprehension":
      return "a list";
    case "lambda":
      return "a function";
    case "dict":
      return "a dict";
    case "walrus":
      return describeValue(fieldOf(value, "value"));
    case "binary":
      return `${describeValue(fieldOf(value, "left"))} ${value.op} ${describeValue(fieldOf(value, "right"))}`;
    case "unary":
      return `${value.op}${describeValue(fieldOf(value, "operand"))}`;
    case "conditional":
      return "a conditional";
    case "sized":
      return "a list";
    default:
      return "a value";
  }
}

/* -------------------------------------------------------------------------- */
/* Reading a file                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every value a body holds, and the line it was written on.
 *
 * The line of a statement is the line of the values in it: a value carries no
 * line of its own, and the statement it was written in is where it was
 * written.
 */
function eachValue(body: readonly PyStatement[], visit: (value: PyValue, line: number) => void): void {
  for (const statement of body) {
    switch (statement.k) {
      case "declare":
      case "assign":
        eachValueIn(fieldOf(statement, "value"), visit, statement.line);
        break;
      case "return":
        if (fieldOf(statement, "value") !== null) eachValueIn(fieldOf(statement, "value"), visit, statement.line);
        break;
      case "if":
        eachValueIn(fieldOf(statement, "condition"), visit, Number(fieldOf(statement, "line")));
        eachValue(fieldOf(statement, "then"), visit);
        eachValue(fieldOf(statement, "otherwise"), visit);
        break;
      case "while":
        eachValueIn(fieldOf(statement, "condition"), visit, Number(fieldOf(statement, "line")));
        eachValue(fieldOf(statement, "body"), visit);
        break;
      case "for":
        eachValueIn(fieldOf(statement, "from"), visit, Number(fieldOf(statement, "line")));
        eachValueIn(fieldOf(statement, "to"), visit, Number(fieldOf(statement, "line")));
        if (fieldOf(statement, "step") !== null) eachValueIn(fieldOf(statement, "step"), visit, Number(fieldOf(statement, "line")));
        eachValue(fieldOf(statement, "body"), visit);
        break;
      case "print":
        (fieldOf(statement, "values") as PyValue[]).forEach((value: PyValue) => eachValueIn(value, visit, Number(fieldOf(statement, "line"))));
        break;
      case "try":
        eachValue(fieldOf(statement, "body"), visit);
        if (statement.catchBody !== null) eachValue(statement.catchBody, visit);
        if (statement.finallyBody !== null) eachValue(statement.finallyBody, visit);
        break;
      case "call":
        eachValueIn(fieldOf(statement, "value"), visit, statement.line);
        break;
      case "break":
      case "continue":
      case "pass":
      case "function":
        break;
    }
  }
}

/** The values a value holds, and the value itself. */
function eachValueIn(value: PyValue, visit: (value: PyValue, line: number) => void, line: number): void {
  visit(value, line);
  switch (value.k) {
    case "call":
      (fieldOf(value, "args") as PyValue[]).forEach((argument: PyValue) => eachValueIn(argument, visit, line));
      return;
    case "binary":
      eachValueIn(fieldOf(value, "left"), visit, line);
      eachValueIn(fieldOf(value, "right"), visit, line);
      return;
    case "unary":
      eachValueIn(fieldOf(value, "operand") as PyValue, visit, line);
      return;
    case "conditional":
      eachValueIn(fieldOf(value, "condition"), visit, line);
      eachValueIn(fieldOf(value, "then"), visit, line);
      eachValueIn(fieldOf(value, "otherwise"), visit, line);
      return;
    case "index":
      eachValueIn(fieldOf(value, "base"), visit, line);
      eachValueIn(fieldOf(value, "index"), visit, line);
      return;
    case "slice":
      eachValueIn(fieldOf(value, "base"), visit, line);
      if (fieldOf(value, "start") !== null) eachValueIn(fieldOf(value, "start"), visit, line);
      if (fieldOf(value, "stop") !== null) eachValueIn(fieldOf(value, "stop"), visit, line);
      if (fieldOf(value, "step") !== null) eachValueIn(fieldOf(value, "step"), visit, line);
      return;
    case "field":
      eachValueIn(fieldOf(value, "base"), visit, line);
      return;
    case "list":
      (fieldOf(value, "items") as PyValue[]).forEach((item: PyValue) => eachValueIn(item, visit, line));
      return;
    case "set":
      (fieldOf(value, "items") as PyValue[]).forEach((item: PyValue) => eachValueIn(item, visit, line));
      return;
    case "sized":
      eachValueIn(value.count, visit, line);
      return;
    case "membership":
      eachValueIn(fieldOf(value, "value"), visit, line);
      eachValueIn(fieldOf(value, "container"), visit, line);
      return;
    case "comprehension":
      eachValueIn(fieldOf(value, "element"), visit, line);
      eachValueIn(fieldOf(value, "iterable"), visit, line);
      if (fieldOf(value, "condition") !== null) eachValueIn(fieldOf(value, "condition"), visit, line);
      return;
    case "lambda":
      eachValueIn(fieldOf(value, "body"), visit, line);
      return;
    case "walrus":
      eachValueIn(fieldOf(value, "value"), visit, line);
      return;
    case "dict":
      (fieldOf(value, "entries") as PyValue[]).forEach((entry: PyValue) => eachValueIn(fieldOf(entry, "value"), visit, line));
      return;
    case "text":
      (fieldOf(value, "parts") as PyTextPart[]).forEach((part) => {
        if (part.k === "value") eachValueIn(fieldOf(part, "value"), visit, line);
      });
      return;
    case "number":
    case "boolean":
    case "none":
    case "name":
      return;
  }
}

/**
 * Every call a body makes, with the line it was written on.
 */
function callsOf(body: readonly PyStatement[], into: Map<string, number>): void {
  eachValue(body, (value, line) => {
    if (value.k !== "call" || into.has(value.name)) return;
    into.set(value.name, line);
  });
}

/**
 * Whether a body reads the command line, which a module function may not: a
 * module is a library of functions, and a library reads no command line.
 */
function readsCommandLine(body: readonly PyStatement[]): boolean {
  let found = false;
  eachValue(body, (value) => {
    if (value.k !== "field" || value.field !== "argv") return;
    if (fieldOf(value, "base").k === "name" && fieldOf(value, "base").name === "sys") found = true;
  });
  return found;
}

/**
 * A Python file, read into what it declares, imports and runs.
 */
/**
 * Fills in the arguments a call omits, using the defaults its callee declares.
 *
 * A default value is a value the caller may leave out, and leaving it out is
 * the same as writing it in: the call is rewritten to carry it, so nothing
 * downstream has to know that it was optional.
 */
function fillDefaultArguments(module: PyModule): PyModule {
  const defaults = new Map<string, PyValue[]>();
  for (const fn of fieldOf(module, "functions") as PyFunction[]) {
    const params = fieldOf(fn, "params") as PyParam[];
    const values: PyValue[] = [];
    for (const param of params) values[values.length] = fieldOf(param, "default") as PyValue;
    defaults.set(String(fieldOf(fn, "name")), values);
  }
  function fillValue(value: PyValue, table: Map<string, PyValue[]>): PyValue {
    if (value.k === "call") {
      const ds = table.get(String(fieldOf(value, "name")));
      const args = fieldOf(value, "args") as PyValue[];
      if (ds !== undefined && args.length < ds.length) {
        const padded: PyValue[] = [];
        for (let i = 0; i < args.length; i++) padded[padded.length] = args[i];
        for (let i = args.length; i < ds.length; i++) {
          const fallback = ds[i];
          if (fallback === undefined) break;
          padded[padded.length] = fallback;
        }
        setFieldOn(value, "args", padded);
      }
      const current = fieldOf(value, "args") as PyValue[];
      const filledArgs: PyValue[] = [];
      for (const inner of current) filledArgs[filledArgs.length] = fillValue(inner, table);
      setFieldOn(value, "args", filledArgs);
      const grid = fieldOf(value, "grid");
      if (grid !== undefined) setFieldOn(value, "grid", fillValue(grid, table));
      return value;
    }
    // Recurse into composite values.
    switch (value.k) {
      case "binary":
        setFieldOn(value, "left", fillValue(fieldOf(value, "left"), table));
        setFieldOn(value, "right", fillValue(fieldOf(value, "right"), table));
        break;
      case "unary":
        setFieldOn(value, "operand", fillValue(fieldOf(value, "operand"), table));
        break;
      case "conditional":
        setFieldOn(value, "condition", fillValue(fieldOf(value, "condition"), table));
        setFieldOn(value, "then", fillValue(fieldOf(value, "then"), table));
        setFieldOn(value, "otherwise", fillValue(fieldOf(value, "otherwise"), table));
        break;
      case "index":
        setFieldOn(value, "base", fillValue(fieldOf(value, "base"), table));
        setFieldOn(value, "index", fillValue(fieldOf(value, "index"), table));
        break;
      case "slice":
        setFieldOn(value, "base", fillValue(fieldOf(value, "base"), table));
        if (fieldOf(value, "start") !== null) setFieldOn(value, "start", fillValue(fieldOf(value, "start"), table));
        if (fieldOf(value, "stop") !== null) setFieldOn(value, "stop", fillValue(fieldOf(value, "stop"), table));
        if (fieldOf(value, "step") !== null) setFieldOn(value, "step", fillValue(fieldOf(value, "step"), table));
        break;
      case "list":
      case "set": {
        const items: PyValue[] = [];
        for (const inner of fieldOf(value, "items") as PyValue[]) items[items.length] = fillValue(inner, table);
        setFieldOn(value, "items", items);
        break;
      }
      case "membership":
        setFieldOn(value, "value", fillValue(fieldOf(value, "value"), table));
        setFieldOn(value, "container", fillValue(fieldOf(value, "container"), table));
        break;
      case "comprehension":
        setFieldOn(value, "element", fillValue(fieldOf(value, "element"), table));
        setFieldOn(value, "iterable", fillValue(fieldOf(value, "iterable"), table));
        if (fieldOf(value, "condition") !== null) setFieldOn(value, "condition", fillValue(fieldOf(value, "condition"), table));
        break;
      case "lambda":
        setFieldOn(value, "body", fillValue(fieldOf(value, "body"), table));
        break;
      case "dict": {
        const entries: PyValue[] = [];
        for (const one of fieldOf(value, "entries") as PyValue[]) {
          const copy = structuredClone(one) as PyValue;
          setFieldOn(copy, "value", fillValue(fieldOf(one, "value") as PyValue, table));
          entries[entries.length] = copy;
        }
        setFieldOn(value, "entries", entries);
        break;
      }
      case "field":
        setFieldOn(value, "base", fillValue(fieldOf(value, "base"), table));
        break;
    }
    return value;
  }
  function fillStatement(stmt: PyStatement, table: Map<string, PyValue[]>): PyStatement {
    switch (stmt.k) {
      case "declare":
      case "call":
        setFieldOn(stmt, "value", fillValue(fieldOf(stmt, "value"), table));
        break;
      case "assign":
        setFieldOn(stmt, "value", fillValue(fieldOf(stmt, "value"), table));
        break;
      case "storeField":
      case "storeElement":
        setFieldOn(stmt, "target", fillValue(fieldOf(stmt, "target"), table));
        setFieldOn(stmt, "value", fillValue(fieldOf(stmt, "value"), table));
        break;
      case "storeSlice":
        if (fieldOf(stmt, "start") !== null) setFieldOn(stmt, "start", fillValue(fieldOf(stmt, "start"), table));
        if (fieldOf(stmt, "stop") !== null) setFieldOn(stmt, "stop", fillValue(fieldOf(stmt, "stop"), table));
        if (fieldOf(stmt, "step") !== null) setFieldOn(stmt, "step", fillValue(fieldOf(stmt, "step"), table));
        setFieldOn(stmt, "value", fillValue(fieldOf(stmt, "value"), table));
        break;
      case "return":
        if (fieldOf(stmt, "value") !== null) setFieldOn(stmt, "value", fillValue(fieldOf(stmt, "value"), table));
        break;
      case "if": {
        setFieldOn(stmt, "condition", fillValue(fieldOf(stmt, "condition"), table));
        const thenBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "then") as PyStatement[]) thenBody[thenBody.length] = fillStatement(inner, table);
        const otherwiseBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "otherwise") as PyStatement[]) otherwiseBody[otherwiseBody.length] = fillStatement(inner, table);
        setFieldOn(stmt, "then", thenBody);
        setFieldOn(stmt, "otherwise", otherwiseBody);
        break;
      }
      case "while": {
        setFieldOn(stmt, "condition", fillValue(fieldOf(stmt, "condition"), table));
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = fillStatement(inner, table);
        setFieldOn(stmt, "body", body);
        break;
      }
      case "for": {
        setFieldOn(stmt, "from", fillValue(fieldOf(stmt, "from"), table));
        setFieldOn(stmt, "to", fillValue(fieldOf(stmt, "to"), table));
        if (fieldOf(stmt, "step") !== null) setFieldOn(stmt, "step", fillValue(fieldOf(stmt, "step"), table));
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = fillStatement(inner, table);
        setFieldOn(stmt, "body", body);
        break;
      }
      case "print": {
        const values: PyValue[] = [];
        for (const inner of fieldOf(stmt, "values") as PyValue[]) values[values.length] = fillValue(inner, table);
        setFieldOn(stmt, "values", values);
        break;
      }
      case "function": {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = fillStatement(inner, table);
        setFieldOn(stmt, "body", body);
        break;
      }
      case "try": {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = fillStatement(inner, table);
        setFieldOn(stmt, "body", body);
        const catchBody = fieldOf(stmt, "catchBody") as PyStatement[] | null;
        if (catchBody !== null) {
          const caught: PyStatement[] = [];
          for (const inner of catchBody) caught[caught.length] = fillStatement(inner, table);
          setFieldOn(stmt, "catchBody", caught);
        }
        const finallyBody = fieldOf(stmt, "finallyBody") as PyStatement[] | null;
        if (finallyBody !== null) {
          const cleaned: PyStatement[] = [];
          for (const inner of finallyBody) cleaned[cleaned.length] = fillStatement(inner, table);
          setFieldOn(stmt, "finallyBody", cleaned);
        }
        break;
      }
    }
    return stmt;
  }
  const filledFunctions: PyFunction[] = [];
  for (const fn of fieldOf(module, "functions") as PyFunction[]) {
    const filledBodyOfFn: PyStatement[] = [];
    for (const inner of fieldOf(fn, "body") as PyStatement[]) filledBodyOfFn[filledBodyOfFn.length] = fillStatement(inner, defaults);
    const copy = structuredClone(fn) as PyFunction;
    setFieldOn(copy, "body", filledBodyOfFn);
    filledFunctions[filledFunctions.length] = copy;
  }
  const filledBody: PyStatement[] = [];
  for (const inner of fieldOf(module, "body") as PyStatement[]) filledBody[filledBody.length] = fillStatement(inner, defaults);
  const filled = structuredClone(module) as PyModule;
  setFieldOn(filled, "functions", filledFunctions);
  setFieldOn(filled, "body", filledBody);
  return filled;
}

/**
 * Lifts a walrus out of an expression into the statement that holds it.
 *
 * `x := e` is `e` written into `x`: the value of the expression is `e`, and
 * the assignment happens where the expression is evaluated. An expression
 * cannot carry a statement, so the assignment is lifted to the statement that
 * holds the expression, and the walrus is replaced by a read of the name.
 */
function expandWalrus(module: PyModule): PyModule {
  /** Appends the statements a value has to run before it, and answers the value. */
  const expandExpr = (value: PyValue, scope: Set<string>, pre: PyStatement[]): PyValue => {
    switch (value.k) {
      case "walrus": {
        const held = expandExpr(fieldOf(value, "value"), scope, pre);
        const innerLine = fieldOf(fieldOf(value, "value"), "line");
        const walrusLine = innerLine === undefined ? 1 : Number(innerLine);
        const declared = scope.has(value.name);
        const stmt: PyStatement = declared
          ? { k: "assign", name: value.name, op: "=", value: held, line: walrusLine }
          : { k: "declare", name: value.name, type: null, value: held, line: walrusLine };
        if (!declared) scope.add(value.name);
        pre[pre.length] = stmt;
        return { k: "name", name: value.name };
      }
      case "binary": {
        const left = expandExpr(fieldOf(value, "left") as PyValue, scope, pre);
        const right = expandExpr(fieldOf(value, "right") as PyValue, scope, pre);
        return { ...value, left, right };
      }
      case "unary":
        return { ...value, operand: expandExpr(fieldOf(value, "operand") as PyValue, scope, pre) };
      case "conditional": {
        const condition = expandExpr(fieldOf(value, "condition") as PyValue, scope, pre);
        const then = expandExpr(fieldOf(value, "then") as PyValue, scope, pre);
        const otherwise = expandExpr(fieldOf(value, "otherwise") as PyValue, scope, pre);
        return { ...value, condition, then, otherwise };
      }
      case "index": {
        const base = expandExpr(fieldOf(value, "base") as PyValue, scope, pre);
        const index = expandExpr(fieldOf(value, "index") as PyValue, scope, pre);
        return { ...value, base, index };
      }
      case "slice": {
        const base = expandExpr(fieldOf(value, "base") as PyValue, scope, pre);
        const startValue = fieldOf(value, "start") as PyValue | null;
        const stopValue = fieldOf(value, "stop") as PyValue | null;
        const stepValue = fieldOf(value, "step") as PyValue | null;
        const start = startValue === null ? null : expandExpr(startValue, scope, pre);
        const stop = stopValue === null ? null : expandExpr(stopValue, scope, pre);
        const step = stepValue === null ? null : expandExpr(stepValue, scope, pre);
        return { ...value, base, start, stop, step };
      }
      case "list":
      case "set": {
        const items: PyValue[] = [];
        for (const one of fieldOf(value, "items") as PyValue[]) items[items.length] = expandExpr(one, scope, pre);
        const copy = structuredClone(value) as PyValue;
        setFieldOn(copy, "items", items);
        return copy;
      }
      case "membership": {
        const held = expandExpr(fieldOf(value, "value") as PyValue, scope, pre);
        const container = expandExpr(fieldOf(value, "container") as PyValue, scope, pre);
        return { ...value, value: held, container };
      }
      case "comprehension": {
        const element = expandExpr(fieldOf(value, "element") as PyValue, scope, pre);
        const iterable = expandExpr(fieldOf(value, "iterable") as PyValue, scope, pre);
        const conditionValue = fieldOf(value, "condition") as PyValue | null;
        const condition = conditionValue === null ? null : expandExpr(conditionValue, scope, pre);
        return { ...value, element, iterable, condition };
      }
      case "dict": {
        const entries: (typeof value.entries)[number][] = [];
        for (const entry of fieldOf(value, "entries") as (typeof value.entries)[number][]) {
          const entryValue = expandExpr(fieldOf(entry, "value") as PyValue, scope, pre);
          const copy = structuredClone(entry) as (typeof value.entries)[number];
          setFieldOn(copy, "value", entryValue);
          entries[entries.length] = copy;
        }
        return { ...value, entries };
      }
      case "field": {
        const copy = structuredClone(value) as PyValue;
        setFieldOn(copy, "base", expandExpr(fieldOf(value, "base") as PyValue, scope, pre));
        return copy;
      }
      case "call": {
        const args: PyValue[] = [];
        for (const one of fieldOf(value, "args") as PyValue[]) args[args.length] = expandExpr(one, scope, pre);
        const gridValue = fieldOf(value, "grid") as PyValue | undefined;
        const grid = gridValue === undefined ? undefined : expandExpr(gridValue, scope, pre);
        return { ...value, args, grid };
      }
      case "lambda":
        // Walrus inside a lambda is not lifted (a lambda has no statement
        // list); leave the node as it is.
        return value;
      default:
        return value;
    }
  };

  const expandStmt = (stmt: PyStatement, scope: Set<string>, out: PyStatement[]): void => {
    switch (stmt.k) {
      case "declare":
      case "call":
      case "assign": {
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "value", expandExpr(fieldOf(stmt, "value") as PyValue, scope, out));
        out[out.length] = copy;
        return;
      }
      case "storeElement": {
        const target = expandExpr(fieldOf(stmt, "target") as PyValue, scope, out);
        const value = expandExpr(fieldOf(stmt, "value") as PyValue, scope, out);
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "target", target);
        setFieldOn(copy, "value", value);
        out[out.length] = copy;
        return;
      }
      case "storeField": {
        const target = expandExpr(fieldOf(stmt, "target") as PyValue, scope, out);
        const value = expandExpr(fieldOf(stmt, "value") as PyValue, scope, out);
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "target", target);
        setFieldOn(copy, "value", value);
        out[out.length] = copy;
        return;
      }
      case "storeSlice": {
        const startValue = fieldOf(stmt, "start") as PyValue | null;
        const stopValue = fieldOf(stmt, "stop") as PyValue | null;
        const stepValue = fieldOf(stmt, "step") as PyValue | null;
        const start = startValue === null ? null : expandExpr(startValue, scope, out);
        const stop = stopValue === null ? null : expandExpr(stopValue, scope, out);
        const step = stepValue === null ? null : expandExpr(stepValue, scope, out);
        const value = expandExpr(fieldOf(stmt, "value") as PyValue, scope, out);
        out[out.length] = withFields(stmt, { start: start, stop: stop, step: step, value: value });
        return;
      }
      case "return": {
        const held = fieldOf(stmt, "value") as PyValue | null;
        if (held === null) {
          out[out.length] = stmt;
          return;
        }
        out[out.length] = withFields(stmt, { value: expandExpr(held, scope, out) });
        return;
      }
      case "if": {
        const condition = expandExpr(fieldOf(stmt, "condition") as PyValue, scope, out);
        const thenBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "then") as PyStatement[]) expandStmt(inner, scope, thenBody);
        const otherwiseBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "otherwise") as PyStatement[]) expandStmt(inner, scope, otherwiseBody);
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "condition", condition);
        setFieldOn(copy, "then", thenBody);
        setFieldOn(copy, "otherwise", otherwiseBody);
        out[out.length] = copy;
        return;
      }
      case "while": {
        const conditionPre: PyStatement[] = [];
        const condition = expandExpr(fieldOf(stmt, "condition") as PyValue, scope, conditionPre);
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, scope, body);
        if (conditionPre.length === 0) {
          const kept = structuredClone(stmt) as PyStatement;
          setFieldOn(kept, "condition", condition);
          setFieldOn(kept, "body", body);
          out[out.length] = kept;
          return;
        }
        // A condition with side effects (such as a walrus) must be
        // re-evaluated every turn, so it cannot be lifted out of the loop.
        // Re-run its assignments and test it each turn, using a flag to leave
        // the loop when it turns false, since a `break` here would not be
        // carried to the right place.
        const line = Number(fieldOf(stmt, "line"));
        const flag = `_walrus_cond_${line}`;
        out[out.length] = { k: "declare", name: flag, type: null, value: { k: "boolean", value: true }, line };
        const turnBody: PyStatement[] = [];
        for (const one of conditionPre) turnBody[turnBody.length] = one;
        turnBody[turnBody.length] = {
          k: "if",
          condition: { k: "unary", op: "not", operand: condition },
          then: [{ k: "assign", name: flag, op: "=", value: { k: "boolean", value: false }, line }],
          otherwise: body,
          line,
        };
        out[out.length] = {
          k: "while",
          condition: { k: "name", name: flag },
          body: turnBody,
          line,
        };
        return;
      }
      case "for": {
        const from = expandExpr(fieldOf(stmt, "from") as PyValue, scope, out);
        const to = expandExpr(fieldOf(stmt, "to") as PyValue, scope, out);
        const stepValue = fieldOf(stmt, "step") as PyValue | null;
        const step = stepValue === null ? null : expandExpr(stepValue, scope, out);
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, scope, body);
        out[out.length] = withFields(stmt, { from: from, to: to, step: step, body: body });
        return;
      }
      case "print": {
        const values: PyValue[] = [];
        for (const one of fieldOf(stmt, "values") as PyValue[]) values[values.length] = expandExpr(one, scope, out);
        out[out.length] = withFields(stmt, { values: values });
        return;
      }
      case "function": {
        const fnParams = fieldOf(stmt, "params") as { name: string }[];
        const fnScope: Set<string> = new Set();
        for (const name of scope) fnScope.add(name);
        for (const param of fnParams) fnScope.add(String(fieldOf(param, "name")));
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, fnScope, body);
        out[out.length] = withFields(stmt, { body: body });
        return;
      }
      case "try": {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, scope, body);
        const catchValue = fieldOf(stmt, "catchBody") as PyStatement[] | null;
        let catchBody: PyStatement[] | null = null;
        if (catchValue !== null) {
          catchBody = [];
          for (const inner of catchValue) expandStmt(inner, scope, catchBody);
        }
        const finallyValue = fieldOf(stmt, "finallyBody") as PyStatement[] | null;
        let finallyBody: PyStatement[] | null = null;
        if (finallyValue !== null) {
          finallyBody = [];
          for (const inner of finallyValue) expandStmt(inner, scope, finallyBody);
        }
        out[out.length] = withFields(stmt, { body: body, catchBody: catchBody, finallyBody: finallyBody });
        return;
      }
      default:
        out[out.length] = stmt;
        return;
    }
  };

  const expandedFunctions: PyFunction[] = [];
  for (const fn of fieldOf(module, "functions") as PyFunction[]) {
    const fnScope: Set<string> = new Set();
    for (const param of fieldOf(fn, "params") as PyParam[]) fnScope.add(String(fieldOf(param, "name")));
    const rewritten: PyStatement[] = [];
    for (const st of fieldOf(fn, "body") as PyStatement[]) expandStmt(st, fnScope, rewritten);
    const copy = structuredClone(fn) as PyFunction;
    setFieldOn(copy, "body", rewritten);
    expandedFunctions[expandedFunctions.length] = copy;
  }
  const expandedBody: PyStatement[] = [];
  for (const st of fieldOf(module, "body") as PyStatement[]) expandStmt(st, new Set(), expandedBody);
  return withModuleBody(module, expandedFunctions, expandedBody);
}

/**
 * Lifts a comprehension in a function into the statements that build it.
 *
 * A comprehension is a list built by a loop: it cannot be an expression in a
 * language whose lists are fixed buffers, so it is rewritten as a buffer that
 * a loop fills, and the name of that buffer takes its place in the expression.
 * Only comprehensions over a bound whose size the compiler can settle on are
 * lifted; a filtered one, or one over a value whose size is not known, is left
 * for the refusal that follows.
 */
function expandComprehensions(module: PyModule): PyModule {
  /** Appends the statements a value has to run before it, and answers the value. */
  const expandExpr = (value: PyValue, scope: Set<string>, pre: PyStatement[]): PyValue => {
    switch (value.k) {
      case "comprehension": {
        // Determine the size and the item expression.
        const iterable = fieldOf(value, "iterable") as PyValue;
        const element = fieldOf(value, "element") as PyValue;
        const target = String(fieldOf(value, "target"));
        let sizeExpr: PyValue | null = null;
        const names: Map<string, PyType> = new Map();
        if (String(fieldOf(iterable, "k")) === "call" && String(fieldOf(iterable, "name")) === "range" && (fieldOf(iterable, "args") as PyValue[]).length === 1) {
          sizeExpr = (fieldOf(iterable, "args") as PyValue[])[0];
          // item is int
          names.set(target, "int");
        } else if (String(fieldOf(iterable, "k")) === "list") {
          const iterableItems = fieldOf(iterable, "items") as PyValue[];
          sizeExpr = { k: "number", text: String(iterableItems.length), whole: true };
          // item is list[i]
          if (iterableItems.length > 0 && String(fieldOf(iterableItems[0], "k")) === "number" && fieldOf(iterableItems[0], "whole") === true) {
            names.set(target, "int");
          } else {
            names.set(target, "float");
          }
        } else if (String(fieldOf(iterable, "k")) === "name") {
          sizeExpr = { k: "call", name: "len", args: [iterable] };
          // assume list[int] -> int; list[float] -> float unknown, default float
          names.set(target, "float");
        } else {
          return value; // leave for refusal
        }
        if (fieldOf(value, "condition") !== null) {
          // Filtered comprehensions are not lifted (size unknown).
          return value;
        }
        const elementIsInt = typeOfValue(element, names) === "int";
        const elementType: "i64" | "f64" = elementIsInt ? "i64" : "f64";
        const temp = "_comp_1";
        const loopVar = "_ci";
        // item binding expression: for range, item = loopVar; for others, item = iterable[loopVar]
        let itemBinding: PyValue;
        if (String(fieldOf(iterable, "k")) === "call" && String(fieldOf(iterable, "name")) === "range") {
          itemBinding = { k: "name", name: loopVar };
        } else {
          itemBinding = { k: "index", base: iterable, index: { k: "name", name: loopVar } };
        }
        const sized = sizeExpr as PyValue;
        pre[pre.length] = { k: "declare", name: temp, type: null, value: { k: "sized", element: elementType, count: sized }, line: 1 };
        const loopBody: PyStatement[] = [
          { k: "declare", name: target, type: null, value: itemBinding, line: 1 },
          { k: "storeElement", target: { k: "index", base: { k: "name", name: temp }, index: { k: "name", name: loopVar } }, value: element, line: 1 },
        ];
        pre[pre.length] = {
          k: "for",
          variable: loopVar,
          from: { k: "number", text: "0", whole: true },
          to: sized,
          step: null,
          body: loopBody,
          line: 1,
        };
        return { k: "name", name: temp };
      }
      case "binary": {
        const left = expandExpr(fieldOf(value, "left") as PyValue, scope, pre);
        const right = expandExpr(fieldOf(value, "right") as PyValue, scope, pre);
        return { ...value, left, right };
      }
      case "unary":
        return { ...value, operand: expandExpr(fieldOf(value, "operand") as PyValue, scope, pre) };
      case "conditional": {
        const condition = expandExpr(fieldOf(value, "condition") as PyValue, scope, pre);
        const then = expandExpr(fieldOf(value, "then") as PyValue, scope, pre);
        const otherwise = expandExpr(fieldOf(value, "otherwise") as PyValue, scope, pre);
        return { ...value, condition, then, otherwise };
      }
      case "index": {
        const base = expandExpr(fieldOf(value, "base") as PyValue, scope, pre);
        const index = expandExpr(fieldOf(value, "index") as PyValue, scope, pre);
        return { ...value, base, index };
      }
      case "slice": {
        const base = expandExpr(fieldOf(value, "base") as PyValue, scope, pre);
        const startValue = fieldOf(value, "start") as PyValue | null;
        const stopValue = fieldOf(value, "stop") as PyValue | null;
        const stepValue = fieldOf(value, "step") as PyValue | null;
        const start = startValue === null ? null : expandExpr(startValue, scope, pre);
        const stop = stopValue === null ? null : expandExpr(stopValue, scope, pre);
        const step = stepValue === null ? null : expandExpr(stepValue, scope, pre);
        return { ...value, base, start, stop, step };
      }
      case "list": {
        const items: PyValue[] = [];
        for (const one of fieldOf(value, "items") as PyValue[]) items[items.length] = expandExpr(one, scope, pre);
        return { k: "list", items } as PyValue;
      }
      case "membership": {
        const held = expandExpr(fieldOf(value, "value") as PyValue, scope, pre);
        const container = expandExpr(fieldOf(value, "container") as PyValue, scope, pre);
        return { ...value, value: held, container };
      }
      case "dict": {
        const entries: (typeof value.entries)[number][] = [];
        for (const entry of fieldOf(value, "entries") as (typeof value.entries)[number][]) {
          const entryValue = expandExpr(fieldOf(entry, "value") as PyValue, scope, pre);
          const copy = structuredClone(entry) as (typeof value.entries)[number];
          setFieldOn(copy, "value", entryValue);
          entries[entries.length] = copy;
        }
        return { ...value, entries };
      }
      case "field": {
        const copy = structuredClone(value) as PyValue;
        setFieldOn(copy, "base", expandExpr(fieldOf(value, "base") as PyValue, scope, pre));
        return copy;
      }
      case "call": {
        const args: PyValue[] = [];
        for (const one of fieldOf(value, "args") as PyValue[]) args[args.length] = expandExpr(one, scope, pre);
        const gridValue = fieldOf(value, "grid") as PyValue | undefined;
        const grid = gridValue === undefined ? undefined : expandExpr(gridValue, scope, pre);
        return { ...value, args, grid };
      }
      case "walrus": {
        const held = expandExpr(fieldOf(value, "value"), scope, pre);
        const innerLine = fieldOf(fieldOf(value, "value"), "line");
        const walrusLine = innerLine === undefined ? 1 : Number(innerLine);
        const declared = scope.has(value.name);
        const stmt: PyStatement = declared
          ? { k: "assign", name: value.name, op: "=", value: held, line: walrusLine }
          : { k: "declare", name: value.name, type: null, value: held, line: walrusLine };
        if (!declared) scope.add(value.name);
        pre[pre.length] = stmt;
        return { k: "name", name: value.name };
      }
      default:
        return value;
    }
  };

  const expandStmt = (stmt: PyStatement, scope: Set<string>, out: PyStatement[]): void => {
    switch (stmt.k) {
      case "declare":
        out[out.length] = withFields(stmt, { value: expandExpr(fieldOf(stmt, "value") as PyValue, scope, out) });
        if (!scope.has(stmt.name)) scope.add(stmt.name);
        return;
      case "assign":
      case "call": {
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "value", expandExpr(fieldOf(stmt, "value") as PyValue, scope, out));
        out[out.length] = copy;
        return;
      }
      case "storeElement":
      case "storeField": {
        const target = expandExpr(fieldOf(stmt, "target") as PyValue, scope, out);
        const value = expandExpr(fieldOf(stmt, "value") as PyValue, scope, out);
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "target", target);
        setFieldOn(copy, "value", value);
        out[out.length] = copy;
        return;
      }
      case "storeSlice": {
        const startValue = fieldOf(stmt, "start") as PyValue | null;
        const stopValue = fieldOf(stmt, "stop") as PyValue | null;
        const stepValue = fieldOf(stmt, "step") as PyValue | null;
        const start = startValue === null ? null : expandExpr(startValue, scope, out);
        const stop = stopValue === null ? null : expandExpr(stopValue, scope, out);
        const step = stepValue === null ? null : expandExpr(stepValue, scope, out);
        const value = expandExpr(fieldOf(stmt, "value") as PyValue, scope, out);
        out[out.length] = withFields(stmt, { start: start, stop: stop, step: step, value: value });
        return;
      }
      case "return": {
        const held = fieldOf(stmt, "value") as PyValue | null;
        if (held === null) {
          out[out.length] = stmt;
          return;
        }
        out[out.length] = withFields(stmt, { value: expandExpr(held, scope, out) });
        return;
      }
      case "if": {
        const condition = expandExpr(fieldOf(stmt, "condition") as PyValue, scope, out);
        const thenBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "then") as PyStatement[]) expandStmt(inner, scope, thenBody);
        const otherwiseBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "otherwise") as PyStatement[]) expandStmt(inner, scope, otherwiseBody);
        const copy = structuredClone(stmt) as PyStatement;
        setFieldOn(copy, "condition", condition);
        setFieldOn(copy, "then", thenBody);
        setFieldOn(copy, "otherwise", otherwiseBody);
        out[out.length] = copy;
        return;
      }
      case "while": {
        const conditionPre: PyStatement[] = [];
        const condition = expandExpr(fieldOf(stmt, "condition") as PyValue, scope, conditionPre);
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, scope, body);
        if (conditionPre.length === 0) {
          out[out.length] = withFields(stmt, { condition: condition, body: body });
          return;
        }
        const line = Number(fieldOf(stmt, "line"));
        const flag = `_walrus_cond_${line}`;
        out[out.length] = { k: "declare", name: flag, type: null, value: { k: "boolean", value: true }, line };
        const turnBody: PyStatement[] = [];
        for (const one of conditionPre) turnBody[turnBody.length] = one;
        turnBody[turnBody.length] = {
          k: "if",
          condition: { k: "unary", op: "not", operand: condition },
          then: [{ k: "assign", name: flag, op: "=", value: { k: "boolean", value: false }, line }],
          otherwise: body,
          line,
        };
        out[out.length] = { k: "while", condition: { k: "name", name: flag }, body: turnBody, line };
        return;
      }
      case "for": {
        const from = expandExpr(fieldOf(stmt, "from") as PyValue, scope, out);
        const to = expandExpr(fieldOf(stmt, "to") as PyValue, scope, out);
        const stepValue = fieldOf(stmt, "step") as PyValue | null;
        const step = stepValue === null ? null : expandExpr(stepValue, scope, out);
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, scope, body);
        out[out.length] = withFields(stmt, { from: from, to: to, step: step, body: body });
        return;
      }
      case "print": {
        const values: PyValue[] = [];
        for (const one of fieldOf(stmt, "values") as PyValue[]) values[values.length] = expandExpr(one, scope, out);
        out[out.length] = withFields(stmt, { values: values });
        return;
      }
      case "function": {
        const fnScope: Set<string> = new Set();
        for (const name of scope) fnScope.add(name);
        for (const param of fieldOf(stmt, "params") as { name: string }[]) fnScope.add(String(fieldOf(param, "name")));
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, fnScope, body);
        out[out.length] = withFields(stmt, { body: body });
        return;
      }
      case "try": {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) expandStmt(inner, scope, body);
        const catchValue = fieldOf(stmt, "catchBody") as PyStatement[] | null;
        let catchBody: PyStatement[] | null = null;
        if (catchValue !== null) {
          catchBody = [];
          for (const inner of catchValue) expandStmt(inner, scope, catchBody);
        }
        const finallyValue = fieldOf(stmt, "finallyBody") as PyStatement[] | null;
        let finallyBody: PyStatement[] | null = null;
        if (finallyValue !== null) {
          finallyBody = [];
          for (const inner of finallyValue) expandStmt(inner, scope, finallyBody);
        }
        out[out.length] = withFields(stmt, { body: body, catchBody: catchBody, finallyBody: finallyBody });
        return;
      }
      default:
        out[out.length] = stmt;
        return;
    }
  };

  const expandedFunctions: PyFunction[] = [];
  for (const fn of fieldOf(module, "functions") as PyFunction[]) {
    const fnScope: Set<string> = new Set();
    for (const param of fieldOf(fn, "params") as PyParam[]) fnScope.add(String(fieldOf(param, "name")));
    const rewritten: PyStatement[] = [];
    for (const st of fieldOf(fn, "body") as PyStatement[]) expandStmt(st, fnScope, rewritten);
    const copy = structuredClone(fn) as PyFunction;
    setFieldOn(copy, "body", rewritten);
    expandedFunctions[expandedFunctions.length] = copy;
  }
  const expandedBody: PyStatement[] = [];
  for (const st of fieldOf(module, "body") as PyStatement[]) expandStmt(st, new Set(), expandedBody);
  return withModuleBody(module, expandedFunctions, expandedBody);
}

function packRestArguments(module: PyModule): PyModule {
  const restIndex = new Map<string, number>();
  for (const fn of fieldOf(module, "functions") as PyFunction[]) {
    let idx = -1;
    const params = fieldOf(fn, "params") as PyParam[];
    for (let at = 0; at < params.length; at++) if (fieldOf(params[at], "rest") === true) idx = at;
    if (idx >= 0) restIndex.set(String(fieldOf(fn, "name")), idx);
  }
  function packValue(value: PyValue, rest: Map<string, number>): PyValue {
    if (value.k === "call") {
      const idx = rest.get(String(fieldOf(value, "name")));
      if (idx !== undefined) {
        const fixed = idx; // number of fixed params before *args
        const original = fieldOf(value, "args") as PyValue[];
        if (original.length > fixed) {
          const fixedArgs: PyValue[] = [];
          for (let at = 0; at < fixed; at++) fixedArgs[fixedArgs.length] = original[at];
          const extra: PyValue[] = [];
          for (let at = fixed; at < original.length; at++) extra[extra.length] = original[at];
          fixedArgs[fixedArgs.length] = { k: "list", items: extra };
          setFieldOn(value, "args", fixedArgs);
        } else if (original.length === fixed) {
          const padded: PyValue[] = [];
          for (const one of original) padded[padded.length] = one;
          padded[padded.length] = { k: "list", items: [] };
          setFieldOn(value, "args", padded);
        }
      }
      const packedArgs: PyValue[] = [];
      for (const inner of fieldOf(value, "args") as PyValue[]) packedArgs[packedArgs.length] = packValue(inner, rest);
      setFieldOn(value, "args", packedArgs);
      if (fieldOf(value, "grid") !== undefined) setFieldOn(value, "grid", packValue(fieldOf(value, "grid"), rest));
      return value;
    }
    switch (value.k) {
      case "binary":
        setFieldOn(value, "left", packValue(fieldOf(value, "left"), rest));
        setFieldOn(value, "right", packValue(fieldOf(value, "right"), rest));
        break;
      case "unary":
        setFieldOn(value, "operand", packValue(fieldOf(value, "operand"), rest));
        break;
      case "conditional":
        setFieldOn(value, "condition", packValue(fieldOf(value, "condition"), rest));
        setFieldOn(value, "then", packValue(fieldOf(value, "then"), rest));
        setFieldOn(value, "otherwise", packValue(fieldOf(value, "otherwise"), rest));
        break;
      case "index":
        setFieldOn(value, "base", packValue(fieldOf(value, "base"), rest));
        setFieldOn(value, "index", packValue(fieldOf(value, "index"), rest));
        break;
      case "slice":
        setFieldOn(value, "base", packValue(fieldOf(value, "base"), rest));
        if (fieldOf(value, "start") !== null) setFieldOn(value, "start", packValue(fieldOf(value, "start"), rest));
        if (fieldOf(value, "stop") !== null) setFieldOn(value, "stop", packValue(fieldOf(value, "stop"), rest));
        if (fieldOf(value, "step") !== null) setFieldOn(value, "step", packValue(fieldOf(value, "step"), rest));
        break;
      case "list":
        {
        const items: PyValue[] = [];
        for (const inner of fieldOf(value, "items")) items[items.length] = packValue(inner, rest);
        setFieldOn(value, "items", items);
      }
        break;
      case "set":
        {
        const items: PyValue[] = [];
        for (const inner of fieldOf(value, "items")) items[items.length] = packValue(inner, rest);
        setFieldOn(value, "items", items);
      }
        break;
      case "membership":
        setFieldOn(value, "value", packValue(fieldOf(value, "value"), rest));
        setFieldOn(value, "container", packValue(fieldOf(value, "container"), rest));
        break;
      case "comprehension":
        setFieldOn(value, "element", packValue(fieldOf(value, "element"), rest));
        setFieldOn(value, "iterable", packValue(fieldOf(value, "iterable"), rest));
        if (fieldOf(value, "condition") !== null) setFieldOn(value, "condition", packValue(fieldOf(value, "condition"), rest));
        break;
      case "lambda":
        setFieldOn(value, "body", packValue(fieldOf(value, "body"), rest));
        break;
      case "dict":
        {
        const entries: PyValue[] = [];
        for (const one of fieldOf(value, "entries") as PyValue[]) {
          const copy = structuredClone(one) as PyValue;
          setFieldOn(copy, "value", packValue(fieldOf(one, "value") as PyValue, rest));
          entries[entries.length] = copy;
        }
        setFieldOn(value, "entries", entries);
      }
        break;
      case "field":
        setFieldOn(value, "base", packValue(fieldOf(value, "base"), rest));
        break;
      case "walrus":
        value.value = packValue(fieldOf(value, "value"), rest);
        break;
    }
    return value;
  }
  function packStmt(stmt: PyStatement, rest: Map<string, number>): PyStatement {
    switch (stmt.k) {
      case "declare":
        setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "assign":
        setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "storeField":
        setFieldOn(stmt, "target", packValue(fieldOf(stmt, "target"), rest));
        setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "storeElement":
        setFieldOn(stmt, "target", packValue(fieldOf(stmt, "target"), rest) as any);
        setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "storeSlice":
        if (fieldOf(stmt, "start") !== null) setFieldOn(stmt, "start", packValue(fieldOf(stmt, "start"), rest));
        if (fieldOf(stmt, "stop") !== null) setFieldOn(stmt, "stop", packValue(fieldOf(stmt, "stop"), rest));
        if (fieldOf(stmt, "step") !== null) setFieldOn(stmt, "step", packValue(fieldOf(stmt, "step"), rest));
        setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "return":
        if (fieldOf(stmt, "value") !== null) setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "if":
        setFieldOn(stmt, "condition", packValue(fieldOf(stmt, "condition"), rest));
        {
        const thenBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "then") as PyStatement[]) thenBody[thenBody.length] = packStmt(inner, rest);
        setFieldOn(stmt, "then", thenBody);
      }
        {
        const otherwiseBody: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "otherwise") as PyStatement[]) otherwiseBody[otherwiseBody.length] = packStmt(inner, rest);
        setFieldOn(stmt, "otherwise", otherwiseBody);
      }
        break;
      case "while":
        setFieldOn(stmt, "condition", packValue(fieldOf(stmt, "condition"), rest));
        {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = packStmt(inner, rest);
        setFieldOn(stmt, "body", body);
      }
        break;
      case "for":
        setFieldOn(stmt, "from", packValue(fieldOf(stmt, "from"), rest));
        setFieldOn(stmt, "to", packValue(fieldOf(stmt, "to"), rest));
        if (fieldOf(stmt, "step") !== null) setFieldOn(stmt, "step", packValue(fieldOf(stmt, "step"), rest));
        {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = packStmt(inner, rest);
        setFieldOn(stmt, "body", body);
      }
        break;
      case "print":
        {
        const values: PyValue[] = [];
        for (const inner of fieldOf(stmt, "values") as PyValue[]) values[values.length] = packValue(inner, rest);
        setFieldOn(stmt, "values", values);
      }
        break;
      case "call":
        setFieldOn(stmt, "value", packValue(fieldOf(stmt, "value"), rest));
        break;
      case "function":
        {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = packStmt(inner, rest);
        setFieldOn(stmt, "body", body);
      }
        break;
      case "try":
        {
        const body: PyStatement[] = [];
        for (const inner of fieldOf(stmt, "body") as PyStatement[]) body[body.length] = packStmt(inner, rest);
        setFieldOn(stmt, "body", body);
      }
        if (stmt.catchBody !== null) {
          const caught: PyStatement[] = [];
          for (const inner of fieldOf(stmt, "catchBody") as PyStatement[]) caught[caught.length] = packStmt(inner, rest);
          setFieldOn(stmt, "catchBody", caught);
        }
        if (stmt.finallyBody !== null) {
          const cleaned: PyStatement[] = [];
          for (const inner of fieldOf(stmt, "finallyBody") as PyStatement[]) cleaned[cleaned.length] = packStmt(inner, rest);
          setFieldOn(stmt, "finallyBody", cleaned);
        }
        break;
    }
    return stmt;
  }
  const packedFunctions: PyFunction[] = [];
  for (const fn of fieldOf(module, "functions") as PyFunction[]) {
    const copy = structuredClone(fn) as PyFunction;
    setFieldOn(copy, "body", (fieldOf(fn, "body") as PyStatement[]).map((inner) => packStmt(inner, restIndex)));
    packedFunctions[packedFunctions.length] = copy;
  }
  const packedBody: PyStatement[] = [];
  for (const inner of fieldOf(module, "body") as PyStatement[]) packedBody[packedBody.length] = packStmt(inner, restIndex);
  return withModuleBody(module, packedFunctions, packedBody);
}

export function parsePython(source: string, path: string, diagnostics: Diagnostics): PyModule {
  const parser = new PythonParser(tokenizePython(source, path), path, diagnostics);
  const module = parser.parseModule();
  return packRestArguments(fillDefaultArguments(expandWalrus(expandComprehensions(module))));
}

/* -------------------------------------------------------------------------- */
/* The compiler's view of a Python type                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a Python value is, as far as the frontend can tell. It is what the
 * conditions and the divisions are settled by, and it is a guess where the
 * frontend cannot know: a name of a function the project declares is one the
 * frontend does not read.
 */
export type PyType = "int" | "float" | "bool" | "text" | "list" | "dict" | "none" | "unknown";

/** The type of a value, as far as the frontend can tell. */
export function typeOfValue(value: PyValue, names: Map<string, PyType>): PyType {
  switch (value.k) {
    case "number":
      return value.whole ? "int" : "float";
    case "text":
      return "text";
    case "boolean":
      return "bool";
    case "none":
      return "none";
    case "name": {
      const known = names.get(value.name);
      return known ?? "unknown";
    }
    case "await":
      // The value a promise carries is not known until the function it was
      // awaited from is read, so the frontend says it does not know it.
      return "unknown";
    case "call": {
      if (value.name === "len" || value.name === "range") return "int";
      if (value.name === "int") return "int";
      if (value.name === "dict_new") return "int";
      if (value.name === "dict_get") return "float";
      if (value.name === "dict_set") return "int";
      if (value.name === "dict_has") return "bool";
      if (value.name === "dict_len") return "int";
      if (value.name === "float") return "float";
      if (value.name === "str") return "text";
      if (value.name === "abs" || value.name === "min" || value.name === "max") {
        const first = fieldOf(value, "args")[0];
        return first === undefined ? "unknown" : typeOfValue(first, names);
      }
      if (value.name === "math.floor" || value.name === "math.ceil" || value.name === "math.trunc") return "int";
      if (value.name === "math.sqrt") return "float";
      if (value.name === "tl.sqrt" || value.name === "tl.math.sqrt") return "float";
      if (value.name === "tl.floor" || value.name === "tl.math.floor") return "int";
      if (value.name === "tl.ceil" || value.name === "tl.math.ceil") return "int";
      if (value.name === "tl.math.exp" || value.name === "tl.math.log" || value.name === "tl.math.sin" || value.name === "tl.math.cos") return "float";
      if (value.name === "tl.abs" || value.name === "tl.math.abs") {
        const first = fieldOf(value, "args")[0];
        return first === undefined ? "unknown" : typeOfValue(first, names);
      }
      // `tl.where` answers whichever of the two values the condition chose, so
      // the type of the answer is the type the two have in common.
      if (value.name === "tl.where" && fieldOf(value, "args").length === 3) {
        const then = typeOfValue(fieldOf(value, "args")[1], names);
        const otherwise = typeOfValue(fieldOf(value, "args")[2], names);
        return then === otherwise ? then : "unknown";
      }
      return "unknown";
    }
    case "index":
      return "unknown";
    case "slice":
      return "unknown";
    case "field":
      return "unknown";
    case "list":
      return "list";
    case "set":
      return "list";
    case "sized":
      return "list";
    case "membership":
      return "bool";
    case "comprehension":
      return "list";
    case "lambda":
      return "unknown";
    case "walrus":
      return typeOfValue(fieldOf(value, "value"), names);
    case "dict":
      return "dict";
    case "unary":
      return value.op === "not" ? "bool" : typeOfValue(fieldOf(value, "operand"), names);
    case "binary": {
      if (COMPARISONS.includes(value.op)) return "bool";
      // A power is always floating: `2 ** 3` is `8.0`, and a whole number is
      // read back with `int`.
      if (value.op === "**") return "float";
      const left = typeOfValue(fieldOf(value, "left"), names);
      const right = typeOfValue(fieldOf(value, "right"), names);
      if (left === "float" || right === "float") return "float";
      if (left === "int" && right === "int") return "int";
      if (left === "bool" && right === "bool") return "bool";
      return "unknown";
    }
    case "conditional": {
      const then = typeOfValue(fieldOf(value, "then"), names);
      const otherwise = typeOfValue(fieldOf(value, "otherwise"), names);
      return then === otherwise ? then : "unknown";
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Lowering a body into the compiler's IR                                      */
/* -------------------------------------------------------------------------- */

/** The operators of the compiler's IR that a Python operator lowers to. */
const IR_OPERATORS: Record<string, BinaryOp> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "//": "//",
  "**": "**",
  "%": "%",
  "==": "==",
  "!=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "and": "&&",
  "or": "||",
};

/** A dotted name for a field access chain, e.g. `tl.math.exp`. */
function dottedName(value: PyValue): string {
  if (value.k === "name") return value.name;
  if (value.k === "field") {
    return `${dottedName(fieldOf(value, "base"))}.${value.field}`;
  }
  return "";
}

/**
 * Whether a field access chain is rooted at a module rather than at a value.
 *
 * `tl.math.exp` is one name of one function in a module, and not the method
 * `exp` of an object `tl.math`: the chain is read as the dotted name it is so
 * that the frontend knows which builtin the source asked for. A chain rooted at
 * a value the program holds, such as `req.path`, is a field of that value and
 * may be a method call, which is the other reading of `name(args)`.
 */
function isModulePath(value: PyValue): boolean {
  if (value.k === "name") return value.name === "tl" || KNOWN_MODULES.includes(value.name);
  if (value.k === "field") return isModulePath(fieldOf(value, "base"));
  return false;
}

function isTritonBuiltin(name: string): boolean {
  if (name.startsWith("tl.")) {
    if (name === "tl.where") return true;
    if (
      name === "tl.abs" ||
      name === "tl.sqrt" ||
      name === "tl.floor" ||
      name === "tl.ceil" ||
      name === "tl.math.abs" ||
      name === "tl.math.sqrt" ||
      name === "tl.math.floor" ||
      name === "tl.math.ceil" ||
      name === "tl.math.exp" ||
      name === "tl.math.log" ||
      name === "tl.math.sin" ||
      name === "tl.math.cos"
    )
      return true;
    if (
      name === "tl.load" ||
      name === "tl.store" ||
      name === "tl.program_id" ||
      name === "tl.num_programs" ||
      name === "tl.arange" ||
      name === "tl.full" ||
      name === "tl.zeros" ||
      name === "tl.ones"
    )
      return true;
    return false;
  }
  if (name.startsWith("triton.")) return true;
  return false;
}

/** The operators of the compiler's IR that a Python unary lowers to. */
const IR_UNARY: Record<string, UnaryOp> = {
  "-": "-",
  "+": "+",
  "~": "~",
  not: "!",
};

/**
 * A Python value, as the compiler's IR writes it.
 *
 * The IR is language neutral, so the operators of Python that the compiler
 * has no spelling for are spelled here: `//` is a floor division, which the
 * IR carries as itself, and `and` and `or` are the logical operators the IR
 * has.
 */
export function lowerValue(value: PyValue): Expression {
  switch (value.k) {
    case "number":
      return { k: "literal", text: value.text };
    case "text":
      return { k: "text", parts: (fieldOf(value, "parts") as PyTextPart[]).map((part) => (part.k === "text" ? part : { k: "value", value: lowerValue(fieldOf(part, "value")) })) };
    case "boolean":
      return { k: "literal", text: fieldOf(value, "value") === true ? "1" : "0" };
    case "none":
      return { k: "null" };
    case "name":
      return { k: "ident", name: value.name };
    case "call": {
      // `len(x)` on a dictionary reads the number of entries it holds.
      const callArgs = fieldOf(value, "args") as PyValue[];
      const firstArg = callArgs[0];
      if (value.name === "len" && callArgs.length === 1 && firstArg.k === "name" && currentDictNames.has(String(fieldOf(firstArg, "name")))) {
        return { k: "call", name: "blaze_rt_dict_len", args: [ { k: "ident", name: String(fieldOf(firstArg, "name")) } ] } as Expression;
      }
      // `len(x)` is the length of the list or of the text `x` holds, and the
      // compiler reads a length off the name it is written by.
      if (value.name === "len" && fieldOf(value, "args").length === 1 && fieldOf(value, "args")[0].k === "name") {
        return { k: "length", buffer: fieldOf(value, "args")[0].name };
      }
      // `tl.where(c, x, y)` is a choice: the condition answers which of the two
      // values the kernel holds, and the IR carries a choice as a conditional
      // whether the source spelled it `a if c else b` or `tl.where`.
      const whereArgs = fieldOf(value, "args") as PyValue[];
      if (value.name === "tl.where" && whereArgs.length === 3) {
        return {
          k: "conditional",
          condition: lowerValue(whereArgs[0]),
          then: lowerValue(whereArgs[1]),
          otherwise: lowerValue(whereArgs[2]),
        };
      }
      // For kernel operations not directly supported by the IR yet, still lower
      // them as calls so they can be refused later with proper diagnostics
      return { k: "call", name: builtinName(value.name), args: (fieldOf(value, "args") as PyValue[]).map(lowerValue) };
    }
    case "index": {
      // A dictionary is a hash map: reading d[key] is dict_get.
      const indexBase = fieldOf(value, "base");
      const indexKey = fieldOf(value, "index");
      if (indexBase.k === "name" && currentDictNames.has(String(fieldOf(indexBase, "name")))) {
        const keyParts = fieldOf(indexKey, "parts") as PyTextPart[];
        const keyStr = indexKey.k === "text"
          ? (keyParts[0]?.k === "text" ? keyParts[0].value : "")
          : null;
        const keyExpr = keyStr !== null
          ? ({ k: "text", parts: [{ k: "text", value: keyStr }] } as unknown as Expression)
          : lowerValue(indexKey);
        return { k: "call", name: "blaze_rt_dict_get", args: [ { k: "ident", name: String(fieldOf(indexBase, "name")) }, keyExpr ] } as Expression;
      }
      // A slice indexed at any position can be simplified to an index of the
      // base: `a[i:j][k]` is `a[i+k]`. The IR's slice returns the base (not
      // a sub-buffer), so without this simplification the wrong element is
      // read. When `i` is null it defaults to 0; a step other than 1 is
      // not handled.
      if (fieldOf(value, "base").k === "slice") {
        const slice = fieldOf(value, "base");
        const step = slice.step;
        const isUnitStep = step === null || (step.k === "number" && Number(step.text) === 1);
        if (isUnitStep) {
          const startExpr = fieldOf(slice, "start") === null
            ? { k: "number" as const, text: "0", whole: true }
            : fieldOf(slice, "start");
          // a[i:j][k] -> a[i + k]
          const new_index: PyValue = { k: "binary", op: "+", left: startExpr, right: fieldOf(value, "index") };
          return { k: "index", base: lowerValue(slice.base), index: lowerValue(new_index) };
        }
      }
      return { k: "index", base: lowerValue(fieldOf(value, "base")), index: lowerValue(fieldOf(value, "index")) };
    }
    case "slice":
      return { k: "slice", base: lowerValue(fieldOf(value, "base")), start: value.start === null ? null : lowerValue(fieldOf(value, "start")), stop: value.stop === null ? null : lowerValue(fieldOf(value, "stop")), step: value.step === null ? null : lowerValue(fieldOf(value, "step")) };
    case "field":
      return { k: "member", base: lowerValue(fieldOf(value, "base")), field: value.field };
    case "comprehension": {
      throw frontendError("a comprehension is not supported in a function", "write the loop out");
    }
    case "lambda": {
      throw frontendError("\"lambda\" is not supported", "a function written with def");
    }
    case "walrus": {
      // Walrus is lifted to a declaration by expandWalrus; one that remains
      // here is in a position that cannot carry a statement.
      throw frontendError("a walrus is not part of the subset", "a name bound by a statement, as in x = 1");
    }
    case "membership": {
      // A dictionary supports membership by key.
      if (fieldOf(value, "container").k === "name" && currentDictNames.has(fieldOf(value, "container").name)) {
        const keyExpr = fieldOf(value, "value").k === "text"
          ? { k: "text", parts: fieldOf(fieldOf(value, "value"), "parts") }
          : lowerValue(fieldOf(value, "value"));
        const has = { k: "call", name: "blaze_rt_dict_has", args: [ { k: "ident", name: fieldOf(value, "container").name }, keyExpr ] } as Expression;
        return value.negated ? { k: "unary", op: "!", operand: has } : has;
      }
      throw frontendError("membership is not supported in a function", "write the loop out");
    }
    case "list": {
      // A list written out is a buffer of the numbers it holds, and the
      // element is the width of what it holds.
      const whole = (fieldOf(value, "items") as PyValue[]).every((item: PyValue) => item.k === "number" && fieldOf(item, "whole"));
      return { k: "buffer", element: whole ? "i64" : "f64", values: (fieldOf(value, "items") as PyValue[]).map(lowerValue) };
    }
    case "set": {
      // A set is a buffer of its (deduplicated) elements. Deduplication is
      // done where the values are known; here we keep every element.
      const whole = (fieldOf(value, "items") as PyValue[]).every((item: PyValue) => item.k === "number" && fieldOf(item, "whole"));
      const seen = new Set<string>();
      const deduped = (fieldOf(value, "items") as PyValue[]).filter((item) => {
        if (item.k !== "number") return true;
        if (seen.has(item.text)) return false;
        seen.add(item.text);
        return true;
      });
      return { k: "buffer", element: whole ? "i64" : "f64", values: deduped.map(lowerValue) };
    }
    case "sized": {
      return { k: "sized", element: fieldOf(value, "element"), count: lowerValue(fieldOf(value, "count")) };
    }
    case "dict": {
      // A dictionary is a hash map: build it with dict_set.
      let expr: Expression = { k: "call", name: "blaze_rt_dict_new", args: [] } as Expression;
      for (const entry of fieldOf(value, "entries")) {
        expr = { k: "call", name: "blaze_rt_dict_set", args: [expr, { k: "text", parts: [{ k: "text", value: entry.name }] } as unknown as Expression, lowerValue(fieldOf(entry, "value"))] } as Expression;
      }
      return expr;
    }
    case "await":
      // `await v` is the value the promise `v` carries; the IR reads the value
      // out of the promise at the use.
      return { k: "call", name: "Promise.await", args: [lowerValue(fieldOf(value, "value"))] };
    case "binary": {
      // Set operations in a function are not lowered: the function's lists are
      // fixed buffers, and a set operation needs a buffer of a size the
      // compiler cannot always settle on. Write the operation out as a loop.
      if (fieldOf(value, "left").k === "set" && fieldOf(value, "right").k === "set") {
        throw frontendError(
          "a set operation is not supported in a function",
          "write the operation out as a loop, as in for x in a: ...",
        );
      }
      const operator = IR_OPERATORS[value.op];
      if (operator === undefined) {
        throw frontendError(`"${value.op}" is not an operator the compiler has`, "the body is refused where it is written");
      }
      return { k: "binary", op: operator, left: lowerValue(fieldOf(value, "left")), right: lowerValue(fieldOf(value, "right")) };
    }
    case "unary": {
      const operator = IR_UNARY[value.op];
      if (operator === undefined) {
        throw frontendError(`"${value.op}" is not an operator the compiler has`, "the body is refused where it is written");
      }
      return { k: "unary", op: operator, operand: lowerValue(fieldOf(value, "operand")) };
    }
    case "conditional":
      return {
        k: "conditional",
        condition: lowerValue(fieldOf(value, "condition")),
        then: lowerValue(fieldOf(value, "then")),
        otherwise: lowerValue(fieldOf(value, "otherwise")),
      };
  }
}

/** A Python statement, as the compiler's IR writes it. */
/** Expand storeSlice statements into multiple storeElement statements. */
function expandStoreSlices(statements: PyStatement[]): PyStatement[] {
  const result: PyStatement[] = [];
  for (const stmt of statements) {
    if (stmt.k === "storeSlice") {
      const s = stmt as { k: "storeSlice"; base: string; start: PyValue | null; stop: PyValue | null; step: PyValue | null; value: PyValue; line: number };
      const base = fieldOf(s, "base");
      const rhsValue = fieldOf(s, "value") as PyValue;
      const rhsItems = String(fieldOf(rhsValue, "k")) === "list" ? (fieldOf(rhsValue, "items") as PyValue[]) : [];
      let startBound = 0;
      if (fieldOf(s, "start") !== null && fieldOf(s, "start").k === "number") {
        startBound = Number(fieldOf(s, "start").text);
      }
      const step = s.step === null ? 1 : (fieldOf(s, "step").k === "number" ? Number(fieldOf(s, "step").text) : 1);
      for (let j = 0; j < rhsItems.length; j++) {
        const idx = startBound + j * step;
        result.push({
          k: "storeElement",
          target: { k: "index", base: { k: "name", name: base }, index: { k: "number", text: String(idx), whole: true } },
          value: rhsItems[j],
          line: s.line,
        });
      }
      // If RHS is not a list, keep as-is (will fail in lowerStatement).
      if (String(fieldOf(fieldOf(s, "value"), "k")) !== "list") {
        result.push(stmt);
      }
    } else if (stmt.k === "if") {
      const copy = structuredClone(stmt) as PyStatement;
      setFieldOn(copy, "then", expandStoreSlices(fieldOf(stmt, "then") as PyStatement[]));
      setFieldOn(copy, "otherwise", expandStoreSlices(fieldOf(stmt, "otherwise") as PyStatement[]));
      result[result.length] = copy;
    } else if (stmt.k === "while" || stmt.k === "for") {
      const copy = structuredClone(stmt) as PyStatement;
      setFieldOn(copy, "body", expandStoreSlices(fieldOf(stmt, "body") as PyStatement[]));
      result[result.length] = copy;
    } else if (stmt.k === "try") {
      const copy = structuredClone(stmt) as PyStatement;
      setFieldOn(copy, "body", expandStoreSlices(fieldOf(stmt, "body") as PyStatement[]));
      const catchValue = fieldOf(stmt, "catchBody") as PyStatement[] | null;
      setFieldOn(copy, "catchBody", catchValue === null ? null : expandStoreSlices(catchValue));
      const finallyValue = fieldOf(stmt, "finallyBody") as PyStatement[] | null;
      setFieldOn(copy, "finallyBody", finallyValue === null ? null : expandStoreSlices(finallyValue));
      result[result.length] = copy;
    } else {
      result[result.length] = stmt;
    }
  }
  return result;
}

/** The names that hold a dictionary in the function currently being lowered. */
let currentDictNames = new Set<string>();

export function lowerStatement(statement: PyStatement): Statement {
  switch (statement.k) {
    case "declare": {
      if (fieldOf(statement, "value").k === "dict") currentDictNames.add(statement.name);
      return { kind: "declare", name: String(fieldOf(statement, "name")), type: fieldOf(statement, "type") as TypeExpr | null, init: lowerValue(fieldOf(statement, "value")), line: Number(fieldOf(statement, "line")) };
    }
    case "assign":
      return {
        kind: "assign",
        target: statement.name,
        op: statement.op as AssignOperator,
        value: lowerValue(fieldOf(statement, "value")),
        line: Number(fieldOf(statement, "line")),
      };
    case "storeField": {
      const target = fieldOf(statement, "target") as { k: "field"; base: PyValue; field: string };
      const base = fieldOf(target, "base") as PyValue;
      if (String(fieldOf(base, "k")) === "name" && currentDictNames.has(String(fieldOf(base, "name")))) {
        return {
          kind: "expression",
          value: {
            k: "call",
            name: "blaze_rt_dict_set",
            args: [ { k: "ident", name: String(fieldOf(base, "name")) }, { k: "text", parts: [{ k: "text", value: String(fieldOf(target, "field")) }] } as Expression, lowerValue(fieldOf(statement, "value") as PyValue) ],
          } as Expression,
          line: Number(fieldOf(statement, "line")),
        };
      }
      if (String(fieldOf(base, "k")) !== "name") {
        throw frontendError(
          '"obj.field = value" is not supported',
          "the object is a name the program holds, as in a.field = value",
        );
      }
      return {
        kind: "memberAssign",
        base: String(fieldOf(base, "name")),
        field: String(fieldOf(target, "field")),
        op: "=" as AssignOperator,
        value: lowerValue(fieldOf(statement, "value") as PyValue),
        line: Number(fieldOf(statement, "line")),
      };
    }
    case "storeElement": {
      const target = fieldOf(statement, "target") as { k: "index"; base: PyValue; index: PyValue };
      const base = fieldOf(target, "base") as PyValue;
      if (String(fieldOf(base, "k")) === "name" && currentDictNames.has(String(fieldOf(base, "name")))) {
        // A dictionary is a hash map: writing d[key] = value is a call.
        const keyParts = fieldOf(fieldOf(target, "index"), "parts") as { k: string; value: string }[];
        const keyStr = fieldOf(target, "index").k === "text"
          ? (keyParts[0] !== undefined && String(fieldOf(keyParts[0], "k")) === "text" ? String(fieldOf(keyParts[0], "value")) : "")
          : null;
        const keyExpr = keyStr !== null
          ? ({ k: "text", parts: [{ k: "text", value: keyStr }] } as unknown as Expression)
          : lowerValue(fieldOf(target, "index"));
        return {
          kind: "expression",
          value: {
            k: "call",
            name: "blaze_rt_dict_set",
            args: [ { k: "ident", name: String(fieldOf(base, "name")) }, keyExpr, lowerValue(fieldOf(statement, "value") as PyValue) ],
          } as Expression,
          line: Number(fieldOf(statement, "line")),
        };
      }
      if (base.k !== "name") {
        throw frontendError('"a[i] = value" is not supported', "the buffer is a name the program holds, as in a[i] = value");
      }
      return {
        kind: "indexAssign",
        buffer: String(fieldOf(base, "name")),
        index: lowerValue(fieldOf(target, "index") as PyValue),
        op: "=" as AssignOperator,
        value: lowerValue(fieldOf(statement, "value") as PyValue),
        line: Number(fieldOf(statement, "line")),
      };
    }
    case "storeSlice": {
      throw frontendError('"a[i:j] = value" is not supported in a function', "a function\'s parameters are read only");
    }
    case "return":
      return { kind: "result", value: lowerValue(fieldOf(statement, "value") ?? { k: "none" }), line: Number(fieldOf(statement, "line")) };
    case "if":
      conditionIsBoolean(fieldOf(statement, "condition"), Number(fieldOf(statement, "line")));
      return {
        kind: "if",
        condition: lowerValue(fieldOf(statement, "condition")),
        then: (fieldOf(statement, "then") as PyStatement[]).map(lowerStatement),
        otherwise: (fieldOf(statement, "otherwise") as PyStatement[]).map(lowerStatement),
        line: Number(fieldOf(statement, "line")),
      };
    case "while":
      conditionIsBoolean(fieldOf(statement, "condition"), Number(fieldOf(statement, "line")));
      return { kind: "while", condition: lowerValue(fieldOf(statement, "condition")), body: (fieldOf(statement, "body") as PyStatement[]).map(lowerStatement), line: Number(fieldOf(statement, "line")) };
    case "for":
      return {
        kind: "loop",
        variable: String(fieldOf(statement, "variable")),
        from: lowerValue(fieldOf(statement, "from")),
        to: lowerValue(fieldOf(statement, "to")),
        inclusive: false,
        step: fieldOf(statement, "step") === null ? null : lowerValue(fieldOf(statement, "step")),
        down: false,
        body: (fieldOf(statement, "body") as PyStatement[]).map(lowerStatement),
        line: Number(fieldOf(statement, "line")),
      };
    case "break":
      return { kind: "break", line: Number(fieldOf(statement, "line")) };
    case "continue":
      return { kind: "continue", line: Number(fieldOf(statement, "line")) };
    case "pass":
      return { kind: "expression", value: { k: "literal", text: "0" }, line: Number(fieldOf(statement, "line")) };
    case "print": {
      // A print writes its values with a space between them, and then the
      // line the console ends it with.
      const parts: TextPart[] = [];
      (fieldOf(statement, "values") as PyValue[]).forEach((value: PyValue, position: number) => {
        if (position > 0) parts.push({ k: "text", value: " " });
        parts.push({ k: "value", value: lowerValue(value) });
      });
      return { kind: "print", value: { k: "text", parts }, line: Number(fieldOf(statement, "line")) };
    }
    case "try":
      return {
        kind: "try",
        body: (fieldOf(statement, "body") as PyStatement[]).map(lowerStatement),
        catchParam: null,
        catchBody: statement.catchBody === null ? null : statement.catchBody.map(lowerStatement),
        finallyBody: statement.finallyBody === null ? null : statement.finallyBody.map(lowerStatement),
        line: Number(fieldOf(statement, "line")),
      };
    case "call":
      return { kind: "expression", value: lowerValue(fieldOf(statement, "value")), line: Number(fieldOf(statement, "line")) };
    case "function":
      throw frontendError(
        "a function may not be declared inside a function",
        `line ${statement.line}: declare it in the module`,
      );
  }
}

/**
 * A condition is a boolean, which is what a Python condition has to be.
 *
 * Python's truth is wider than a boolean: a list of nothing is false and a
 * number that is not a number is true. The compiler's truth is narrower in the
 * ways that matter, so a condition that is not a boolean is refused rather
 * than answered differently.
 */
export function conditionIsBoolean(value: PyValue, line: number): void {
  if (isBooleanCondition(value)) return;
  throw frontendError(
    "a condition must be a boolean",
    `line ${line}: write the comparison it is, as in x > 0, or a name that holds one`,
  );
}

/** Whether a value is a boolean, as a condition reads it. */
export function isBooleanCondition(value: PyValue): boolean {
  switch (value.k) {
    case "boolean":
    case "name":
    case "call":
      return true;
    case "unary":
      return value.op === "not";
    case "binary":
      return COMPARISONS.includes(value.op);
    case "number":
    case "text":
    case "none":
    case "index":
    case "slice":
    case "field":
    case "list":
    case "comprehension":
    case "membership":
    case "lambda":
    case "dict":
    case "conditional":
      return false;
    case "sized":
    case "set":
      return false;
    case "walrus":
      return isBooleanCondition((value as { k: "walrus"; name: string; value: PyValue }).value);
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* The contract of a Python function                                           */
/* -------------------------------------------------------------------------- */

/**
 * A body the contract cannot state as one expression. It is not an error: the
 * contract of such a function carries what the function does instead.
 */
class Uncontractable extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "Uncontractable";
    this.detail = detail;
  }
}

/**
 * The operators the contract language states a result with. A Python body
 * that uses one the contract language has not states no postcondition.
 *
 * The list is the grammar `contract.ts` reads, and not every operator Python
 * has: a floor division (`//`), a power (`**`) and a remainder (`%`) are
 * operations the contract language has no operator for. Writing one into a
 * postcondition is a build refused by the parser for a character it cannot
 * read, so a body using one is contracted by what it does instead, as a body
 * that branches or calls already is.
 */
const CONTRACT_OPERATORS: readonly string[] = ["+", "-", "*", "/", "==", "!=", "<", "<=", ">", ">="];

/**
 * The expression the result must equal, or null when the body has none: a
 * function that branches, recurses, allocates, calls or prints is contracted
 * by what it does, which `definitionContract` carries.
 */
class BodyAnalysis {
  private readonly declaration: PyFunction;
  private readonly bindings = new Map<string, string>();
  readonly accesses: AccessRange[] = [];
  private result: string | null = null;
  /** The type each name holds, as far as the body says. */
  private readonly types = new Map<string, PyType>();

  constructor(declaration: PyFunction) {
    this.declaration = declaration;
    for (const param of fieldOf(declaration, "params")) {
      this.bindings.set(param.name, param.name);
      this.types.set(param.name, pythonTypeOf(param.type));
    }
  }

  run(): { result: string | null; accesses: AccessRange[] } {
    try {
      for (const statement of this.declaration.body) this.execute(statement, null);
    } catch (error) {
      if (!(error instanceof Uncontractable)) throw error;
      return { result: null, accesses: fieldOf(this, "accesses") };
    }
    if (this.result === null && this.declaration.returns.kind !== "void") {
      throw frontendError(
        `${this.declaration.name} never returns a value`,
        "the contract needs an expression the result must equal",
      );
    }
    return { result: this.result, accesses: fieldOf(this, "accesses") };
  }

  private uncontractable(construct: string, line: number, remedy: string): never {
    throw new Uncontractable(
      `${this.declaration.name} cannot be contracted: it ${construct} (line ${line})`,
      remedy,
    );
  }

  private execute(statement: PyStatement, loop: LoopContext | null): void {
    switch (statement.k) {
      case "declare": {
        const value = this.serialize(fieldOf(statement, "value"), loop, Number(Number(fieldOf(statement, "line"))));
        this.bindings.set(String(fieldOf(statement, "name")), value);
        const types = fieldOf(this, "types") as Map<string, PyType>;
        if (fieldOf(statement, "type") !== null) types.set(String(fieldOf(statement, "name")), pythonTypeOf(fieldOf(statement, "type") as TypeExpr));
        else types.set(String(fieldOf(statement, "name")), typeOfValue(fieldOf(statement, "value") as PyValue, fieldOf(this, "types") as Map<string, PyType>));
        return;
      }
      case "assign": {
        const value = this.serialize(fieldOf(statement, "value") as PyValue, loop, Number(Number(fieldOf(statement, "line"))));
        const current = this.bindings.get(String(fieldOf(statement, "name")));
        if (current === undefined) {
          throw frontendError(`assignment to undeclared "${String(fieldOf(statement, "name"))}"`, `line ${Number(Number(fieldOf(statement, "line")))}`);
        }
        const opText = String(String(fieldOf(statement, "op")));
        const operator = opText === "=" ? opText : opText.slice(0, -1);
        if (opText !== "=" && !CONTRACT_OPERATORS.includes(operator)) {
          this.uncontractable(
            `applies "${opText}" to "${String(fieldOf(statement, "name"))}"`,
            Number(Number(fieldOf(statement, "line"))),
            "a contract is one expression the result must equal, and the contract language states + - * and the comparisons",
          );
        }
        this.bindings.set(
          String(fieldOf(statement, "name")),
          opText === "=" ? value : `(${current} ${operator} ${value})`,
        );
        return;
      }
      case "return":
        this.result = this.serialize(fieldOf(statement, "value") ?? { k: "none" }, loop, Number(Number(fieldOf(statement, "line"))), true);
        return;
      case "for":
        this.executeLoop(statement);
        return;
      case "while":
        this.uncontractable("loops while a condition holds", Number(fieldOf(statement, "line")), LOOP_REMEDY);
      case "if":
        this.uncontractable("branches", Number(fieldOf(statement, "line")), LOOP_REMEDY);
      case "break":
        this.uncontractable("leaves a loop", Number(fieldOf(statement, "line")), LOOP_REMEDY);
      case "continue":
        this.uncontractable("skips the rest of a loop body", Number(fieldOf(statement, "line")), LOOP_REMEDY);
      case "try":
        this.uncontractable("uses try/except", Number(fieldOf(statement, "line")), LOOP_REMEDY);
      case "print":
        this.uncontractable("prints", Number(fieldOf(statement, "line")), "a contracted function returns a value and prints nothing");
      case "pass":
        return;
      case "call":
        this.uncontractable(`calls ${describeValue(fieldOf(statement, "value"))}`, Number(fieldOf(statement, "line")), "a contracted function is computed from its parameters alone");
      case "function":
        this.uncontractable("declares a function", Number(fieldOf(statement, "line")), LOOP_REMEDY);
    }
  }

  private executeLoop(statement: PyStatement & { k: "for" }): void {
    if (fieldOf(statement, "step") !== null) {
      this.uncontractable(
        "counts by something other than one",
        Number(fieldOf(statement, "line")),
        "a reduction describes the range it sums over, so the index moves by one",
      );
    }
    if (fieldOf(statement, "body").length !== 1) {
      this.uncontractable(
        "has a loop body of more than one statement",
        Number(fieldOf(statement, "line")),
        "a reduction describes a loop that accumulates into one variable",
      );
    }
    const inner = fieldOf(statement, "body")[0];
    if (inner.k !== "assign" || (String(fieldOf(inner, "op")) !== "+=" && String(fieldOf(inner, "op")) !== "*=")) {
      this.uncontractable(
        "has a loop body that does not accumulate",
        Number(fieldOf(statement, "line")),
        "a reduction describes a loop that accumulates into one variable, as in `total += a[i]`",
      );
    }
    const from = this.serialize(fieldOf(statement, "from"), null, Number(fieldOf(statement, "line")));
    const to = this.serialize(fieldOf(statement, "to"), null, Number(fieldOf(statement, "line")));
    const context: LoopContext = { variable: String(fieldOf(statement, "variable")), lo: from, hiExclusive: to };
    const body = this.serialize(fieldOf(inner, "value"), context, Number(fieldOf(inner, "line")));
    const operator = String(fieldOf(inner, "op")) === "*=" ? "product" : "sum";
    const reduce = `${operator}(${String(fieldOf(statement, "variable"))} = ${from}..<${to}, ${body})`;
    const current = this.bindings.get(String(fieldOf(inner, "name")));
    if (current === undefined) {
      throw frontendError(`loop accumulates into undeclared "${String(fieldOf(inner, "name"))}"`, `line ${Number(fieldOf(inner, "line"))}`);
    }
    this.bindings.set(String(fieldOf(inner, "name")), this.withInitial(current, reduce, operator));
  }

  /**
   * Folds an accumulator's initial value into its reduction. A neutral
   * initialiser is dropped so the contract stays readable; anything else is
   * composed, which is what makes a second loop over the same accumulator
   * expressible at all.
   */
  private withInitial(initial: string | null, reduce: string, operator: "sum" | "product"): string {
    if (initial === null) return reduce;
    const neutral = operator === "sum" ? ["0", "0.0"] : ["1", "1.0"];
    if (neutral.includes(initial)) return reduce;
    return `(${initial} ${operator === "sum" ? "+" : "*"} ${reduce})`;
  }

  /** The contract text of a value, or null when a contract cannot state it. */
  private serialize(value: PyValue, loop: LoopContext | null, line: number, asResult: boolean = false): string {
    switch (value.k) {
      case "number":
        return String(fieldOf(value, "text"));
      case "boolean":
        return fieldOf(value, "value") === true ? "true" : "false";
      case "none":
        return "null";
      case "text":
        // The contract language has no string, so a body that hands one back
        // states no postcondition.
        this.uncontractable("returns text", line, "a contract states what a function returns, which is a number");
      case "name": {
        if (loop !== null && String(fieldOf(value, "name")) === String(fieldOf(loop, "variable"))) return String(fieldOf(value, "name"));
        const bound = this.bindings.get(String(fieldOf(value, "name")));
        if (bound === undefined) {
          throw frontendError(`unknown identifier "${String(fieldOf(value, "name"))}"`, `line ${line}: declare it with an initialiser`);
        }
        return bound;
      }
      case "unary": {
        if (String(fieldOf(value, "op")) !== "-" && String(fieldOf(value, "op")) !== "+") {
          this.uncontractable(
            `applies "${String(fieldOf(value, "op"))}" to a value`,
            line,
            "a contract states what a function returns, which is a number",
          );
        }
        return `(${String(fieldOf(value, "op"))}${this.serialize(fieldOf(value, "operand"), loop, line)})`;
      }
      case "binary": {
        // List concatenation: a + b where both are lists. The contract
        // language has no concatenation, so the function is uncontractable.
        if (String(fieldOf(value, "op")) === "+") {
          const leftType = typeOfValue(fieldOf(value, "left"), fieldOf(this, "types"));
          const rightType = typeOfValue(fieldOf(value, "right"), fieldOf(this, "types"));
          if (leftType === "list" && rightType === "list") {
            this.uncontractable("concatenates lists", line, "a contract states what a function returns, which is a number");
          }
        }
        if (!CONTRACT_OPERATORS.includes(String(fieldOf(value, "op")))) {
          this.uncontractable(
            `computes with ${String(fieldOf(value, "op"))}, which a contract cannot state`,
            line,
            "the body states no postcondition, which is what a function that branches or calls has",
          );
        }
        return `(${this.serialize(fieldOf(value, "left"), loop, line)} ${String(fieldOf(value, "op"))} ${this.serialize(fieldOf(value, "right"), loop, line)})`;
      }
      case "index": {
        if (fieldOf(value, "base").k === "slice") {
          // Indexing into a slice: serialize the slice, then index into it.
          const sliceText = this.serialize(fieldOf(value, "base"), loop, line);
          const index = this.serialize(fieldOf(value, "index"), loop, line);
          return `${sliceText}[${index}]`;
        }
        if (fieldOf(value, "base").k !== "name") {
          throw frontendError("only single level indexing is supported", `line ${line}`);
        }
        const base = fieldOf(value, "base");
        const parameter = (fieldOf(this.declaration, "params") as PyParam[]).find((param) => String(fieldOf(param, "name")) === String(fieldOf(base, "name")));
        if (parameter !== undefined) {
          const index = this.serialize(fieldOf(value, "index"), loop, line);
          const accesses = fieldOf(this, "accesses") as AccessRange[];
          const parameterName = String(fieldOf(parameter, "name"));
          if (loop !== null && dependsOn(fieldOf(value, "index"), String(fieldOf(loop, "variable")))) {
            accesses[accesses.length] = { parameter: parameterName, lo: fieldOf(loop, "lo"), hi: fieldOf(loop, "hiExclusive") };
          } else {
            accesses[accesses.length] = { parameter: parameterName, lo: index, hi: `(${index} + 1)` };
          }
          return `${String(fieldOf(parameter, "name"))}[${index}]`;
        }
        // The base may be a bound variable (e.g., a slice), not a parameter.
        const bound = this.bindings.get(String(fieldOf(base, "name")));
        if (bound === undefined) {
          throw frontendError(`indexing unknown parameter "${String(fieldOf(base, "name"))}"`, `line ${line}`);
        }
        const index = this.serialize(fieldOf(value, "index"), loop, line);
        return `${bound}[${index}]`;
      }
    case "comprehension": {
        this.uncontractable("uses a comprehension", line, "a loop that fills a list, written out");
      }
      case "set": {
        this.uncontractable("uses a set", line, "a dict is written with named keys, as in {\"a\": 1}");
        return "0";
      }
      case "lambda": {
        this.uncontractable("uses a lambda", line, "a function written with def");
        return "0";
      }
      case "walrus": {
        this.uncontractable("uses a walrus", line, "a name bound by a statement, as in x = 1");
        return this.serialize((value as { k: "walrus"; name: string; value: PyValue }).value, loop, line);
      }
      case "membership": {
        this.uncontractable("tests membership", line, "a loop that looks for the value");
      }
      case "slice": {
        if (fieldOf(value, "base").k !== "name") {
          throw frontendError("only single level slicing is supported", `line ${line}`);
        }
        const base = fieldOf(value, "base");
        const parameter = (fieldOf(this.declaration, "params") as PyParam[]).find((param) => String(fieldOf(param, "name")) === String(fieldOf(base, "name")));
        if (parameter === undefined) {
          // The base may be a bound variable (e.g., another slice), not a parameter.
          const bound = this.bindings.get(String(fieldOf(base, "name")));
          if (bound === undefined) {
            throw frontendError(`slicing unknown parameter "${String(fieldOf(base, "name"))}"`, `line ${line}`);
          }
          // A slice that is the function's result cannot be stated as a
          // postcondition: the contract language has no buffer equality.
          if (asResult) {
            this.uncontractable("returns a slice", line, "a contract states what a function returns, which is a number");
          }
          const start = fieldOf(value, "start") === null ? "" : this.serialize(fieldOf(value, "start"), loop, line);
          const stop = fieldOf(value, "stop") === null ? "" : this.serialize(fieldOf(value, "stop"), loop, line);
          if (fieldOf(value, "step") !== null) {
            const step = this.serialize(fieldOf(value, "step"), loop, line);
            return `${bound}[${start}:${stop}:${step}]`;
          }
          if (fieldOf(value, "stop") !== null || fieldOf(value, "start") !== null) {
            return `${bound}[${start}:${stop}]`;
          }
          return `${bound}[:]`;
        }
        // A slice that is the function's result cannot be stated as a
        // postcondition: the contract language has no buffer equality.
        if (asResult) {
          this.uncontractable("returns a slice", line, "a contract states what a function returns, which is a number");
        }
        const start = fieldOf(value, "start") === null ? "" : this.serialize(fieldOf(value, "start"), loop, line);
        const stop = fieldOf(value, "stop") === null ? "" : this.serialize(fieldOf(value, "stop"), loop, line);
        // Push an access range for the sliced elements of the parameter.
        const lo = fieldOf(value, "start") === null ? "0" : start;
        const hi = fieldOf(value, "stop") === null ? `len(${String(fieldOf(parameter, "name"))})` : stop;
        const ranges = fieldOf(this, "accesses") as AccessRange[];
        ranges[ranges.length] = { parameter: String(fieldOf(parameter, "name")), lo, hi };
        if (fieldOf(value, "step") !== null) {
          const step = this.serialize(fieldOf(value, "step"), loop, line);
          return `${String(fieldOf(parameter, "name"))}[${start}:${stop}:${step}]`;
        }
        if (fieldOf(value, "stop") !== null || fieldOf(value, "start") !== null) {
          return `${String(fieldOf(parameter, "name"))}[${start}:${stop}]`;
        }
        return `${String(fieldOf(parameter, "name"))}[:]`;
      }
      case "call": {
        // The contract language has one function of its own: `len(x)`, which
        // is the length of the buffer or of the text `x` holds.
        const argument = fieldOf(value, "args").length === 1 ? fieldOf(value, "args")[0] : null;
        if (String(fieldOf(value, "name")) === "len" && argument !== null && argument.k === "name") {
          const parameter = (fieldOf(this.declaration, "params") as PyParam[]).find((param) => String(fieldOf(param, "name")) === String(fieldOf(argument, "name")));
          if (parameter === undefined) {
            throw frontendError(`the length of unknown "${String(fieldOf(argument, "name"))}"`, `line ${line}`);
          }
          return `len(${String(fieldOf(parameter, "name"))})`;
        }
        this.uncontractable(
          `calls ${describeValue(value)}`,
          line,
          "a contracted function is computed from its parameters alone",
        );
      }
      default:
        this.uncontractable(
          "uses a value a contract cannot state",
          line,
          "the body states no postcondition, which is what a function that branches or calls has",
        );
    }
  }
}

/** The range a loop index stands for, which its body reads through. */
interface LoopContext {
  variable: string;
  lo: string;
  hiExclusive: string;
}

/**
 * A loop a reduction cannot state. A counted loop over a range is one the
 * contract can say; every other loop leaves the body to the definition.
 */
const LOOP_REMEDY =
  "a postcondition is one expression the result must equal, so this body states none: the contract carries the statements themselves";

/** Whether an expression reads a name. */
function dependsOn(value: PyValue, name: string): boolean {
  switch (value.k) {
    case "name":
      return value.name === name;
    case "number":
    case "text":
    case "boolean":
    case "none":
      return false;
    case "unary":
      return dependsOn(fieldOf(value, "operand"), name);
    case "await":
      return dependsOn(fieldOf(value, "value"), name);
    case "binary":
      return dependsOn(fieldOf(value, "left"), name) || dependsOn(fieldOf(value, "right"), name);
    case "index":
      return dependsOn(fieldOf(value, "base"), name) || dependsOn(fieldOf(value, "index"), name);
    case "slice":
      return dependsOn(fieldOf(value, "base"), name) || (fieldOf(value, "start") !== null && dependsOn(fieldOf(value, "start"), name)) || (fieldOf(value, "stop") !== null && dependsOn(fieldOf(value, "stop"), name)) || (fieldOf(value, "step") !== null && dependsOn(fieldOf(value, "step"), name));
    case "field":
      return dependsOn(fieldOf(value, "base"), name);
    case "call":
      return (fieldOf(value, "args") as PyValue[]).some((argument: PyValue) => dependsOn(argument, name));
    case "list":
      return (fieldOf(value, "items") as PyValue[]).some((item) => dependsOn(item, name));
    case "comprehension":
      return dependsOn(fieldOf(value, "element"), name) || dependsOn(fieldOf(value, "iterable"), name) || (fieldOf(value, "condition") !== null && dependsOn(fieldOf(value, "condition"), name));
    case "membership":
      return dependsOn(fieldOf(value, "value"), name) || dependsOn(fieldOf(value, "container"), name);
    case "lambda":
      return dependsOn(fieldOf(value, "body"), name);
    case "walrus":
      return dependsOn((value as { k: "walrus"; name: string; value: PyValue }).value, name);
    case "set":
      return (fieldOf(value, "items") as PyValue[]).some((item) => dependsOn(item, name));
    case "sized":
      return dependsOn((value as { k: "sized"; element: "i64" | "f64"; count: PyValue }).count, name);
    case "dict":
      return (fieldOf(value, "entries") as PyValue[]).some((entry) => dependsOn(fieldOf(entry, "value"), name));
    case "conditional":
      return (
        dependsOn(fieldOf(value, "condition"), name) ||
        dependsOn(fieldOf(value, "then"), name) ||
        dependsOn(fieldOf(value, "otherwise"), name)
      );
  }
}

/** The Python type a contract type is. */
function pythonTypeOf(type: TypeExpr): PyType {
  if (type.kind === "void") return "none";
  if (type.kind === "text") return "text";
  if (type.kind === "primitive") {
    if (type.name === "bool") return "bool";
    if (type.name === "f64" || type.name === "f32") return "float";
    return "int";
  }
  if (type.kind === "slice" || type.kind === "array") return "list";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* What a body does                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a body does: whether it allocates, prints or reads the command line,
 * and the buffer ranges it reads.
 */
interface UsageState {
  parameters: Set<string>;
  accesses: AccessRange[];
  loops: Map<string, { lo: string; hi: string }>;
  allocates: boolean;
  prints: boolean;
  readsArgv: boolean;
}

/** One access, stated once however many times the body reads it. */
function usageAccess(state: UsageState, parameter: string, lo: string, hi: string): void {
  const accesses = fieldOf(state, "accesses") as AccessRange[];
  for (const entry of accesses) {
    if (String(fieldOf(entry, "parameter")) === parameter && String(fieldOf(entry, "lo")) === lo && String(fieldOf(entry, "hi")) === hi) return;
  }
  accesses[accesses.length] = { parameter, lo, hi };
}

function usageExpression(value: PyValue, state: UsageState): void {
  const parameters = fieldOf(state, "parameters") as Set<string>;
  const loops = fieldOf(state, "loops") as Map<string, { lo: string; hi: string }>;
  switch (value.k) {
    case "list":
    case "dict": {
      setFieldOn(state, "allocates", true);
      const items: PyValue[] = [];
      if (value.k === "list") {
        for (const one of fieldOf(value, "items") as PyValue[]) items[items.length] = one;
      } else {
        for (const entry of fieldOf(value, "entries") as PyValue[]) items[items.length] = fieldOf(entry, "value") as PyValue;
      }
      for (const item of items) usageExpression(item, state);
      return;
    }
    case "call":
      for (const argument of fieldOf(value, "args") as PyValue[]) usageExpression(argument, state);
      return;
    case "binary":
      usageExpression(fieldOf(value, "left") as PyValue, state);
      usageExpression(fieldOf(value, "right") as PyValue, state);
      return;
    case "unary":
      usageExpression(fieldOf(value, "operand") as PyValue, state);
      return;
    case "conditional":
      usageExpression(fieldOf(value, "condition") as PyValue, state);
      usageExpression(fieldOf(value, "then") as PyValue, state);
      usageExpression(fieldOf(value, "otherwise") as PyValue, state);
      return;
    case "index": {
      const base = fieldOf(value, "base") as PyValue;
      const index = fieldOf(value, "index") as PyValue;
      const baseName = String(fieldOf(base, "name"));
      if (String(fieldOf(base, "k")) === "name" && parameters.has(baseName)) {
        // A buffer the body indexes is a buffer it reads, at a position the
        // contract states as a number. An index the contract language cannot
        // name leaves the position unknown.
        const loop = String(fieldOf(index, "k")) === "name" ? loops.get(String(fieldOf(index, "name"))) : undefined;
        if (loop !== undefined) usageAccess(state, baseName, String(fieldOf(loop, "lo")), String(fieldOf(loop, "hi")));
        else {
          const at = contractTextOf(index);
          if (at !== null) usageAccess(state, baseName, at, `(${at} + 1)`);
        }
      }
      usageExpression(base, state);
      usageExpression(index, state);
      return;
    }
    case "slice": {
      const base = fieldOf(value, "base") as PyValue;
      const baseName = String(fieldOf(base, "name"));
      if (String(fieldOf(base, "k")) === "name" && parameters.has(baseName)) {
        const start = fieldOf(value, "start") as PyValue | null;
        const stop = fieldOf(value, "stop") as PyValue | null;
        const statedStart = start === null ? "0" : (contractTextOf(start) ?? "0");
        const statedStop = stop === null ? `len(${baseName})` : (contractTextOf(stop) ?? `len(${baseName})`);
        usageAccess(state, baseName, statedStart, statedStop);
      }
      usageExpression(base, state);
      const start = fieldOf(value, "start") as PyValue | null;
      if (start !== null) usageExpression(start, state);
      const stop = fieldOf(value, "stop") as PyValue | null;
      if (stop !== null) usageExpression(stop, state);
      const step = fieldOf(value, "step") as PyValue | null;
      if (step !== null) usageExpression(step, state);
      return;
    }
    case "field":
      usageExpression(fieldOf(value, "base") as PyValue, state);
      return;
    case "text":
      for (const part of fieldOf(value, "parts") as PyTextPart[]) {
        if (String(fieldOf(part, "k")) === "value") usageExpression(fieldOf(part, "value") as PyValue, state);
      }
      return;
    case "number":
    case "boolean":
    case "none":
    case "name":
      return;
  }
}

function usageStatement(one: PyStatement, state: UsageState): void {
  const loops = fieldOf(state, "loops") as Map<string, { lo: string; hi: string }>;
  switch (one.k) {
    case "declare":
    case "assign":
      usageExpression(fieldOf(one, "value") as PyValue, state);
      return;
    case "return": {
      const value = fieldOf(one, "value") as PyValue | null;
      if (value !== null) usageExpression(value, state);
      return;
    }
    case "print":
      setFieldOn(state, "prints", true);
      for (const value of fieldOf(one, "values") as PyValue[]) usageExpression(value, state);
      return;
    case "if": {
      usageExpression(fieldOf(one, "condition") as PyValue, state);
      const thenBody = fieldOf(one, "then") as PyStatement[];
      for (const inner of thenBody) usageStatement(inner, state);
      const otherwiseBody = fieldOf(one, "otherwise") as PyStatement[];
      for (const inner of otherwiseBody) usageStatement(inner, state);
      return;
    }
    case "while": {
      usageExpression(fieldOf(one, "condition") as PyValue, state);
      const body = fieldOf(one, "body") as PyStatement[];
      for (const inner of body) usageStatement(inner, state);
      return;
    }
    case "for": {
      const from = fieldOf(one, "from") as PyValue;
      const to = fieldOf(one, "to") as PyValue;
      usageExpression(from, state);
      usageExpression(to, state);
      const step = fieldOf(one, "step") as PyValue | null;
      if (step !== null) usageExpression(step, state);
      // The index of a counted loop stands for the whole range the loop
      // walks, so a buffer its body reads is read over that range.
      const fromText = contractTextOf(from);
      const toText = contractTextOf(to);
      const variable = String(fieldOf(one, "variable"));
      const outer = loops.get(variable);
      if (fromText !== null && toText !== null) loops.set(variable, { lo: fromText, hi: toText });
      const body = fieldOf(one, "body") as PyStatement[];
      for (const inner of body) usageStatement(inner, state);
      if (outer === undefined) loops.delete(variable);
      else loops.set(variable, outer);
      return;
    }
    case "try": {
      const body = fieldOf(one, "body") as PyStatement[];
      for (const inner of body) usageStatement(inner, state);
      const catchBody = fieldOf(one, "catchBody") as PyStatement[] | null;
      if (catchBody !== null) for (const inner of catchBody) usageStatement(inner, state);
      const finallyBody = fieldOf(one, "finallyBody") as PyStatement[] | null;
      if (finallyBody !== null) for (const inner of finallyBody) usageStatement(inner, state);
      return;
    }
    case "call":
      usageExpression(fieldOf(one, "value") as PyValue, state);
      return;
    case "break":
    case "continue":
    case "pass":
    case "function":
      return;
  }
}

function usageOf(declaration: PyFunction): {
  allocates: boolean;
  prints: boolean;
  readsArgv: boolean;
  accesses: AccessRange[];
} {
  const state: UsageState = {
    parameters: new Set<string>(),
    accesses: [],
    loops: new Map(),
    allocates: false,
    prints: false,
    readsArgv: false,
  };
  const parameters = fieldOf(state, "parameters") as Set<string>;
  for (const param of fieldOf(declaration, "params") as PyParam[]) parameters.add(String(fieldOf(param, "name")));
  const body = fieldOf(declaration, "body") as PyStatement[];
  for (const inner of body) usageStatement(inner, state);
  return {
    allocates: fieldOf(state, "allocates") === true,
    prints: fieldOf(state, "prints") === true,
    readsArgv: fieldOf(state, "readsArgv") === true,
    accesses: fieldOf(state, "accesses") as AccessRange[],
  };
}

/** The contract text of a value, or null when a contract cannot state it. */
function contractTextOf(value: PyValue): string | null {
  switch (value.k) {
    case "number":
      return value.text;
    case "name":
      return value.name;
    case "call":
      // The contract language has one function of its own: `len(x)`.
      if (value.name === "len" && fieldOf(value, "args").length === 1 && fieldOf(value, "args")[0].k === "name") {
        return `len(${fieldOf(value, "args")[0].name})`;
      }
      return null;
    case "unary":
      const unaryOp = String(value.op);
      if (unaryOp !== "-" && unaryOp !== "+") return null;
      const operand = contractTextOf(fieldOf(value, "operand") as PyValue);
      return operand === null ? null : `(${unaryOp}${operand})`;
    case "binary": {
      if (!CONTRACT_OPERATORS.includes(value.op)) return null;
      const left = contractTextOf(fieldOf(value, "left"));
      const right = contractTextOf(fieldOf(value, "right"));
      return left === null || right === null ? null : `(${left} ${value.op} ${right})`;
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The frontend                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The first conversion a body holds, or null when it holds none. A conversion
 * is a program of its own: `int(x)` answers a whole number and `str(x)` a
 * text, and a module of functions has neither.
 */
function conversionIn(body: readonly PyStatement[]): string | null {
  for (const statement of body) {
    const found = conversionInStatement(statement);
    if (found !== null) return found;
  }
  return null;
}

function conversionInStatement(statement: PyStatement): string | null {
  switch (statement.k) {
    case "declare":
    case "assign":
    case "storeField":
    case "storeElement":
    case "storeSlice":
      return conversionInValue(fieldOf(statement, "value"));
    case "return":
      return statement.value === null ? null : conversionInValue(fieldOf(statement, "value"));
    case "if":
      return (
        conversionInValue(fieldOf(statement, "condition")) ??
        conversionIn(fieldOf(statement, "then")) ??
        conversionIn(fieldOf(statement, "otherwise"))
      );
    case "while":
      return conversionInValue(fieldOf(statement, "condition")) ?? conversionIn(fieldOf(statement, "body"));
    case "for":
      return (
        conversionInValue(fieldOf(statement, "from")) ??
        conversionInValue(fieldOf(statement, "to")) ??
        conversionIn(fieldOf(statement, "body"))
      );
    case "print":
      return (fieldOf(statement, "values") as PyValue[]).map(conversionInValue).find((found) => found !== null) ?? null;
    case "try":
      return (
        conversionIn(fieldOf(statement, "body")) ??
        (statement.catchBody === null ? null : conversionIn(statement.catchBody)) ??
        (statement.finallyBody === null ? null : conversionIn(statement.finallyBody))
      );
    case "call":
      return conversionInValue(fieldOf(statement, "value"));
    case "break":
    case "continue":
    case "pass":
    case "function":
      return null;
  }
}

function conversionInValue(value: PyValue): string | null {
  switch (value.k) {
    case "call": {
      if (value.name === "int" || value.name === "float" || value.name === "str") return value.name;
      return (fieldOf(value, "args") as PyValue[]).map(conversionInValue).find((found) => found !== null) ?? null;
    }
    case "binary":
      return conversionInValue(fieldOf(value, "left")) ?? conversionInValue(fieldOf(value, "right"));
    case "unary":
      return conversionInValue(fieldOf(value, "operand") as PyValue);
    case "conditional":
      return (
        conversionInValue(fieldOf(value, "condition")) ??
        conversionInValue(fieldOf(value, "then")) ??
        conversionInValue(fieldOf(value, "otherwise"))
      );
    case "index":
      return conversionInValue(fieldOf(value, "base")) ?? conversionInValue(fieldOf(value, "index"));
    case "slice":
      return (
        conversionInValue(fieldOf(value, "base")) ??
        (value.start === null ? null : conversionInValue(fieldOf(value, "start"))) ??
        (value.stop === null ? null : conversionInValue(fieldOf(value, "stop"))) ??
        (value.step === null ? null : conversionInValue(fieldOf(value, "step")))
      );
    case "field":
      return conversionInValue(fieldOf(value, "base"));
    case "list":
      return (fieldOf(value, "items") as PyValue[]).map(conversionInValue).find((found) => found !== null) ?? null;
    case "comprehension":
      return conversionInValue(fieldOf(value, "element")) ?? conversionInValue(fieldOf(value, "iterable")) ?? (value.condition === null ? null : conversionInValue(fieldOf(value, "condition")));
    case "membership":
      return conversionInValue(fieldOf(value, "value")) ?? conversionInValue(fieldOf(value, "container"));
    case "lambda":
      return conversionInValue(fieldOf(value, "body"));
    case "walrus":
      return conversionInValue((value as { k: "walrus"; name: string; value: PyValue }).value);
    case "set":
      return (fieldOf(value, "items") as PyValue[]).map((item) => conversionInValue(item)).find((x) => x !== null) ?? null;
    case "sized":
      return conversionInValue((value as { k: "sized"; element: "i64" | "f64"; count: PyValue }).count);
    default:
      return null;
    case "dict":
      return (fieldOf(value, "entries") as PyValue[]).map((entry) => conversionInValue(fieldOf(entry, "value"))).find((found) => found !== null) ?? null;
    case "text":
      return (fieldOf(value, "parts") as PyTextPart[])
        .filter((part): part is { k: "value"; value: PyValue } => part.k === "value")
        .map((part) => conversionInValue(fieldOf(part, "value")))
        .find((found) => found !== null) ?? null;
    case "number":
    case "boolean":
    case "none":
    case "name":
      return null;
  }
}

/**
 * The Python frontend.
 *
 * A module is a library of functions, and the entry module of a program may
 * also carry the statements the program runs. Python writes both the same way,
 * so the split is the one the contract phase already makes: a file is a
 * program when it has a top level statement that is not a definition.
 */
/**
 * The builtin an async function settles its promise with, for the value its
 * body returns: a string as the text it is, a truth as the truth, a number as
 * the number, nothing as nothing, and a value of a shape the runtime holds as
 * the dynamic value it is.
 */
function promiseSettleName(payload: TypeExpr): string {
  if (payload.kind === "text") return "Promise.settle.text";
  if (payload.kind === "void") return "Promise.settle.nothing";
  if (String(fieldOf(payload, "kind")) === "primitive") {
    const primitive = String(fieldOf(payload, "name"));
    if (primitive === "bool") return "Promise.settle.bool";
    if (!["i256", "u256"].includes(primitive)) return "Promise.settle";
  }
  return "Promise.settle.value";
}

/**
 * An async function's body with every way out of it settling the promise the
 * function answers. A body that falls off the end settles it with nothing.
 */
function settlePromise(statement: Statement, payload: TypeExpr, name: string): Statement {
  switch (statement.kind) {
    case "result": {
      // `return None` settles the promise with nothing, which is the call
      // that takes no value.
      const resultValue = fieldOf(statement, "value");
      const settled = structuredClone(statement) as Statement;
      if (String(fieldOf(payload, "kind")) === "void" || resultValue === null || String(fieldOf(resultValue, "k")) === "null") {
        setFieldOn(settled, "value", { k: "call", name: "Promise.settle.nothing", args: [] });
        return settled;
      }
      setFieldOn(settled, "value", { k: "call", name, args: [resultValue] });
      return settled;
    }
    case "if": {
      const copy = structuredClone(statement) as Statement;
      const thenBody: Statement[] = [];
      for (const inner of fieldOf(statement, "then") as readonly Statement[]) thenBody[thenBody.length] = settlePromise(inner, payload, name);
      const otherwiseBody: Statement[] = [];
      for (const inner of fieldOf(statement, "otherwise") as readonly Statement[]) otherwiseBody[otherwiseBody.length] = settlePromise(inner, payload, name);
      setFieldOn(copy, "then", thenBody);
      setFieldOn(copy, "otherwise", otherwiseBody);
      return copy;
    }
    case "while":
    case "doWhile":
    case "loop":
    case "forOf": {
      const copy = structuredClone(statement) as Statement;
      const body: Statement[] = [];
      for (const inner of fieldOf(statement, "body") as readonly Statement[]) body[body.length] = settlePromise(inner, payload, name);
      setFieldOn(copy, "body", body);
      return copy;
    }
    case "try": {
      const copy = structuredClone(statement) as Statement;
      const catchBody = fieldOf(statement, "catchBody") as readonly Statement[] | null;
      const finallyBody = fieldOf(statement, "finallyBody") as readonly Statement[] | null;
      const body: Statement[] = [];
      for (const inner of fieldOf(statement, "body") as readonly Statement[]) body[body.length] = settlePromise(inner, payload, name);
      setFieldOn(copy, "body", body);
      if (catchBody !== null) {
        const caught: Statement[] = [];
        for (const inner of catchBody) caught[caught.length] = settlePromise(inner, payload, name);
        setFieldOn(copy, "catchBody", caught);
      }
      if (finallyBody !== null) {
        const cleaned: Statement[] = [];
        for (const inner of finallyBody) cleaned[cleaned.length] = settlePromise(inner, payload, name);
        setFieldOn(copy, "finallyBody", cleaned);
      }
      return copy;
    }
    default:
      return statement;
  }
}

function settledPythonBody(statements: readonly Statement[], payload: TypeExpr): Statement[] {
  const name = promiseSettleName(payload);
  const settled: Statement[] = [];
  for (const inner of statements) settled[settled.length] = settlePromise(inner, payload, name);
  const line = statements.length === 0 ? 1 : Number(fieldOf(statements[0], "line"));
  settled[settled.length] = { kind: "result", value: { k: "call", name: "Promise.settle.nothing", args: [] }, line };
  return settled;
}

export const pythonFrontend: Frontend = {
  analyze(source, path, _entry = true): ModuleAnalysis {
    if (typeof source !== "string" || source.trim() === "") {
      throw frontendError(`module ${path} is empty`);
    }
    const diagnostics = new Diagnostics();
    const parsed = parsePython(source, path, diagnostics);
    // A call of a name the compiler does not know is refused, as it is for a
    // TypeScript module: the subset is a list of the names a file may call,
    // and a name outside it is a name the compiler cannot compile.
    const known = new Set<string>();
    for (const declaration of fieldOf(parsed, "functions") as { name: string }[]) known.add(String(fieldOf(declaration, "name")));
    for (const imported of fieldOf(parsed, "imports") as { names?: string[] }[]) {
      const names = fieldOf(imported, "names") as string[] | undefined;
      if (names !== undefined) for (const name of names) known.add(String(name));
    }
    // A name bound to a function (a lambda) may be called as one.
    const collectLambdas = (stmts: PyStatement[]): void => {
      for (const stmt of stmts) {
        if (stmt.k === "declare" && String(fieldOf(fieldOf(stmt, "value"), "k")) === "lambda") known.add(String(fieldOf(stmt, "name")));
        if (stmt.k === "if") { collectLambdas(fieldOf(stmt, "then")); collectLambdas(fieldOf(stmt, "otherwise")); }
        if (stmt.k === "while") collectLambdas(fieldOf(stmt, "body"));
        if (stmt.k === "for") collectLambdas(fieldOf(stmt, "body"));
        if (stmt.k === "function") collectLambdas(fieldOf(stmt, "body"));
        if (stmt.k === "try") {
          collectLambdas(fieldOf(stmt, "body") as PyStatement[]);
          const catchBody = fieldOf(stmt, "catchBody") as PyStatement[] | null;
          if (catchBody !== null) collectLambdas(catchBody);
          const finallyBody = fieldOf(stmt, "finallyBody") as PyStatement[] | null;
          if (finallyBody !== null) collectLambdas(finallyBody);
        }
      }
    };
    const parsedBody = fieldOf(parsed, "body") as PyStatement[];
    collectLambdas(parsedBody);
    for (const fn of fieldOf(parsed, "functions") as { body: PyStatement[] }[]) collectLambdas(fieldOf(fn, "body") as PyStatement[]);
    // A file that holds statements is a program, and a program has the
    // conversions and the roundings a module of functions has not.
    const builtins = parsedBody.length === 0 ? MODULE_BUILTINS : PYTHON_BUILTINS;
    const calls = new Map<string, number>();
    for (const declaration of fieldOf(parsed, "functions") as { body: PyStatement[] }[]) callsOf(fieldOf(declaration, "body") as PyStatement[], calls);
    for (const statement of parsedBody) {
      // The guard that names the entry module runs in the entry module and
      // nowhere else, and the compiler cannot tell which file that is while it
      // reads the file: a call in it is refused when the program is lowered,
      // where the entry is known.
      if (isEntryGuard(statement)) continue;
      callsOf([statement], calls);
    }
    for (const [name, line] of calls) {
      if (known.has(name) || builtins.includes(name)) continue;
      // Allow Triton module calls through the frontend for now; they will be
      // implemented further down the pipeline.
      if (isTritonBuiltin(name) || name.startsWith("tl.") || name.startsWith("triton.")) continue;
      if (CONVERSIONS.includes(name) && builtins === MODULE_BUILTINS) {
        diagnostics.report(
          `"${name}" is not part of a module`,
          `line ${line}: a module is a library of functions, and a conversion is a program of its own`,
          line,
        );
        continue;
      }
      diagnostics.report(
        `"${name}" is not a function this file may call`,
        `line ${line}: a file calls the functions it declares, the functions it imports, and the builtins of the subset (${builtins.join(", ")})`,
        line,
      );
    }
    diagnostics.throwIfAny(path);
    const functions: DeclaredFunction[] = [];
    for (const declaration of fieldOf(parsed, "functions") as { name: string; params: { name: string; type: TypeExpr }[]; returns: TypeExpr }[]) {
      const params: { name: string; type: TypeExpr }[] = [];
      for (const param of fieldOf(declaration, "params") as { name: string; type: TypeExpr }[]) {
        params[params.length] = { name: String(fieldOf(param, "name")), type: fieldOf(param, "type") as TypeExpr };
      }
      // Every function of a Python module is part of its interface: a name
      // that starts with an underscore is a convention, not a rule the
      // compiler reads.
      functions[functions.length] = {
        name: String(fieldOf(declaration, "name")),
        exported: true,
        params,
        returns: fieldOf(declaration, "returns") as TypeExpr,
        handle: declaration,
      };
    }
    // A file is a program when it has a top level statement that is not a
    // definition: the statements the entry module runs are the program, and
    // everything else the file declares is a library of functions.
    const body = parsedBody.length === 0 ? [] : lowerProgramBody(parsedBody);
    return {
      path,
      imports: fieldOf(parsed, "imports") as ModuleImport[],
      functions,
      default: null,
      body,
      entryGuard: fieldOf(parsed, "entryGuard") === true && parsedBody.length > 0,
    };
  },

  contractFor(analysis, declared, input) {
    const declaration = fieldOf(declared, "handle") as PyFunction;
    // A module is a library of functions, and a library reads no command line:
    // the command line is read by the program, which is the statements of the
    // entry module.
    if (readsCommandLine(fieldOf(declaration, "body"))) {
      throw frontendError(
        `${String(fieldOf(declaration, "name"))} reads the command line, which a module may not`,
        `line ${Number(fieldOf(declaration, "line"))} of ${analysis.path}: the command line is read by the program, as in \`sys.argv\` in the statements of the entry module`,
      );
    }
    // A conversion is a program of its own: `int(x)` answers a whole number
    // and `str(x)` a text, and a module of functions has neither.
    if (analysis.body.length === 0) {
      const conversion = conversionIn(fieldOf(declaration, "body"));
      if (conversion !== null) {
        throw frontendError(
          `"${conversion}" is not part of a module`,
          `line ${declaration.line} of ${analysis.path}: a module is a library of functions, and a conversion is a program of its own`,
        );
      }
    }
    const body = new BodyAnalysis(declaration).run();
    const usage = usageOf(declaration);
    // An async function answers a promise carrying what its body returns, so
    // every way out of the body settles that promise. The function's own type
    // is the handle the runtime holds the promise in, and the payload travels
    // beside the contract so a caller's `await` knows what it reads.
    const async = String(fieldOf(declaration, "async")) === "true";
    const returns = fieldOf(declaration, "returns") as TypeExpr;
    const statements: ReturnType<typeof lowerStatement>[] = [];
    for (const one of expandStoreSlices(fieldOf(declaration, "body") as PyStatement[])) statements[statements.length] = lowerStatement(one);
    const parameters: { name: string; type: TypeExpr }[] = [];
    for (const param of fieldOf(declaration, "params") as PyParam[]) {
      parameters[parameters.length] = { name: String(fieldOf(param, "name")), type: fieldOf(param, "type") as TypeExpr };
    }
    const contract = assembleContract({
      name: String(fieldOf(declaration, "name")),
      params: parameters,
      returns: async ? { kind: "ref", of: null } : returns,
      result: async ? null : fieldOf(body, "result"),
      accesses: fieldOf(usage, "accesses") as AccessRange[],
      definition: {
        statements: async ? settledPythonBody(statements, returns) : statements,
        allocates: fieldOf(usage, "allocates") === true,
        prints: fieldOf(usage, "prints") === true,
        readsArgv: fieldOf(usage, "readsArgv") === true,
      },
      input,
    });
    if (!async) return contract;
    setFieldOn(contract, "promise", typeToString(returns));
    return contract;
  },

  resolveImport(specifier) {
    const target = String(specifier);
    if (target === "") {
      throw frontendError("cannot import nothing", "a module imports the functions of another file of the project");
    }
    if (target.includes(".")) {
      throw frontendError(
        `cannot import "${specifier}"`,
        "a module of the project is a file beside the entry file, named without its extension, as in `from helpers import dot`",
      );
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      throw frontendError(
        `cannot import "${specifier}"`,
        "a module of the project is a file beside the entry file, named without its extension, as in `from helpers import dot`",
      );
    }
    return [`${specifier}.py`];
  },
};

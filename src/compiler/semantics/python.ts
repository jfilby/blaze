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

    const character = source[index];
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
      if (letters !== null && STRING_PREFIXES.has(prefix) && (source[after] === '"' || source[after] === "'")) {
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
  while (column < source.length && (source[column] === " " || source[column] === "\t")) column += 1;
  return column;
}

/** How wide the indentation of a line is. A tab is eight columns to the next stop. */
function indentationWidth(source: string, index: number, column: number): number {
  let width = 0;
  for (let at = index; at < column; at += 1) {
    width += source[at] === "\t" ? 8 - (width % 8) : 1;
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
  const quote = source[start];
  const raw = prefix.includes("r");
  // A string of three quotes ends at three quotes, and one of one ends at one.
  const closing = source.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  let index = start + closing.length;
  let text = "";
  for (;;) {
    if (index >= source.length) {
      throw frontendError(`a string of ${path} is never closed`, `line ${line} of ${path}`);
    }
    const character = source[index];
    if (character === "\\") {
      const escape = source[index + 1];
      if (escape === undefined) {
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
  /** A dict written out where it is made. */
  | { k: "dict"; entries: { name: string; value: PyValue }[] }
  | { k: "binary"; op: string; left: PyValue; right: PyValue }
  | { k: "unary"; op: string; operand: PyValue }
  | { k: "conditional"; condition: PyValue; then: PyValue; otherwise: PyValue };

/** A parameter of a function, and the type it was given. */
export interface PyParam {
  name: string;
  type: TypeExpr;
}

/** A statement a Python body runs. */
export type PyStatement =
  | { k: "declare"; name: string; type: TypeExpr | null; value: PyValue; line: number }
  | { k: "assign"; name: string; op: string; value: PyValue; line: number }
  | { k: "storeField"; target: PyValue; value: PyValue; line: number }
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
export const KNOWN_MODULES: ReadonlySet<string> = new Set(["math", "sys", "triton", "triton.language", "__future__"]);

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
    this.diagnostics.report(message, detail, token.line);
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
        // `async` names nothing the compiler keeps: an async function is a
        // function, an async class is a class, and the keyword is dropped
        // where it was written.
        this.next();
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
            for (const baseField of baseClass.fields) {
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
    if (!KNOWN_MODULES.has(path)) {
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
      if (name.text === "as") {
        this.report("renaming an import is not supported", `as written on line ${name.line}`, name);
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
    const startToken = this.peek();
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
    // The newline that ends the line of the decorator is not a statement: the
    // function definition that follows it is read from its own line.
    this.skipNewline();
    if (parts.length === 0 || parts[0] !== "triton") {
      this.report(
        '"@" is not supported',
        "a decorator is not supported: a function is called where it is written, and the decorator is not run",
        startToken,
      );
    }
    return parts.join(".");
  }

  /** `def name(a: int, b: float) -> float:` and the body it holds. */
  private functionDefinition(decorators: string[] = []): PyFunction | null {
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
        if (this.at("*") || this.at("**")) {
          this.next();
          if (this.peek().kind === "name") this.next();
          if (this.at(":")) {
            this.next();
            this.annotation();
          }
          if (this.at("=")) {
            this.next();
            this.expression();
          }
          this.report(
            '"*args" is not supported',
            "a function takes a fixed list of parameters",
            parameter,
          );
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
        // A parameter with a default value is a parameter the caller may leave
        // out, and the contract has no way to say what it is then.
        if (this.at("=")) {
          this.next();
          this.expression();
          this.report(
            "a default value is not supported",
            "a parameter has no default value",
            parameter,
          );
        }
        if (annotation === null) break;
        params.push({ name: parameter.text, type: annotation });
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
    return { name: name.text, params, returns, body, decorators, line: start.line };
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
          this.report(
            '"assert" is not supported',
            "a line written out with print",
            token,
          );
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
          this.report(
            '"del" is not supported',
            "a name is bound for the whole of the scope",
            token,
          );
          return { k: "pass", line: token.line };
        case "global":
        case "nonlocal":
          this.next();
          while (this.peek().kind === "name") {
            this.next();
            if (!this.accept(",")) break;
          }
          this.skipNewline();
          this.report(
            '"global" is not supported',
            "a name is bound in the scope it is written in",
            token,
          );
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
          this.report(
            '"with" is not supported',
            "a plain block",
            token,
          );
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
        case "match":
          this.next();
          this.expression();
          this.expect(":");
          this.skipBlock();
          this.report(
            '"match" is not supported',
            "a chain of if / elif",
            token,
          );
          return { k: "pass", line: token.line };
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
      for (const argument of value.args) {
        if (argument.k !== "list" && argument.k !== "dict") continue;
        this.report(
          "a list or a dict is not written the way Python writes it",
          "the two styles do not cover one: write the elements it holds, one to a line",
          token,
        );
      }
      return { k: "print", values: value.args, line: token.line };
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
    const name = this.peek();
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
    const bounds = walked.args;
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
      if (!this.at(":")) {
        for (;;) {
          if (this.peek().kind === "name") this.next();
          if (this.at(":")) break;
          if (this.accept(",")) continue;
          break;
        }
      }
      this.expect(":");
      this.expression();
      this.report(
        '"lambda" is not supported',
        "a function written with def",
        token,
      );
      return this.hole();
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
      if (this.peek(1).kind === "name" && this.peek(1).text === "not") this.next();
      this.next();
      this.binary(0);
      this.report(
        '"is" is not supported',
        "the comparison `==`",
        token,
      );
      return left;
    }
    if (token.kind === "name" && token.text === "in") {
      this.next();
      this.binary(0);
      this.report(
        '"in" is not supported',
        "a loop that looks for the value",
        token,
      );
      return left;
    }
    if (token.kind === "name" && token.text === "not" && this.peek(1).text === "in") {
      this.next();
      this.next();
      this.binary(0);
      this.report(
        '"not in" is not supported',
        "a loop that looks for the value",
        token,
      );
      return left;
    }
    return left;
  }

  private unary(): PyValue {
    const token = this.peek();
    if (token.kind === "name" && token.text === "await") {
      this.next();
      return this.unary();
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
              ? `${value.base.k === "name" ? value.base.name : describeValue(value.base)}.${value.field}`
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
          const name =
            value.base.k === "name"
              ? value.base.name
              : value.base.k === "field"
                ? dottedName(value.base)
                : "";
          const grid = value.index;
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
          // A slice: a[start:stop] or a[start:stop:step].
          this.next();
          let start: PyValue | null = null;
          let stop: PyValue | null = null;
          let step: PyValue | null = null;
          if (!this.at(":") && !this.at("]")) {
            start = this.expression();
          }
          if (this.at(":")) {
            this.next();
            if (!this.at(":") && !this.at("]")) {
              stop = this.expression();
            }
            if (this.at(":")) {
              this.next();
              if (!this.at("]")) {
                step = this.expression();
              }
            }
          } else if (start !== null && !this.at("]")) {
            // a[i] single index handled below; if we got here via colon above
          }
          this.expect("]");
          // Distinguish a single index from a slice: a slice has a colon.
          // Re-check: if no colon was consumed, treat as index.
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
            right: index.operand,
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
        if (this.at("(") && !(value.k === "name" && (value.name === "tl" || value.name === "math" || value.name === "sys"))) {
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
      const items: PyValue[] = [];
      if (!this.at("]")) {
        for (;;) {
          items.push(this.expression());
          if (this.at("for")) {
            this.report(
              "a comprehension is not part of the subset",
              "a loop that fills a list, written out",
              token,
            );
            // Read past the rest of the comprehension.
            while (this.peek().kind !== "end" && !this.at("]")) this.next();
            if (this.at("]")) this.next();
            return this.hole();
          }
          if (this.accept(",")) continue;
          break;
        }
      }
      this.expect("]");
      return { k: "list", items };
    }
    if (token.kind === "op" && token.text === "{") {
      const entries: { name: string; value: PyValue }[] = [];
      if (!this.at("}")) {
        for (;;) {
          const key = this.next();
          const name = key.kind === "name" || key.kind === "string" ? key.text : null;
          if (name === null) {
            // A set is a dict of nothing, and the subset has no set: the keys
            // of a dict are names.
            this.report(
              "a set is not part of the subset",
              `near "${key.text}"; a dict is written with named keys, as in {"a": 1}`,
              key,
            );
          } else {
            this.expect(":");
            entries.push({ name, value: this.expression() });
          }
          if (this.accept(",")) continue;
          break;
        }
      }
      this.expect("}");
      return { k: "dict", entries };
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
  const condition = statement.condition;
  if (condition.k !== "binary" || condition.op !== "==") return false;
  return isMainText(condition.left) && isMainText(condition.right);
}

/** Whether a value is the text `__main__`. */
function isMainText(value: PyValue): boolean {
  return (
    value.k === "text" &&
    value.parts.length === 1 &&
    value.parts[0].k === "text" &&
    value.parts[0].value === "__main__"
  );
}

/** Where the `}` that closes an interpolation sits, or -1. */
function closingBrace(text: string, open: number): number {  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
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
      return value.value ? "True" : "False";
    case "none":
      return "None";
    case "name":
      return `"${value.name}"`;
    case "call":
      return `"${value.name}(...)"`;
    case "index":
      return `${describeValue(value.base)}[...]`;
    case "slice":
      return `${describeValue(value.base)}[...]`;
    case "field":
      return `${describeValue(value.base)}.${value.field}`;
    case "list":
      return "a list";
    case "dict":
      return "a dict";
    case "binary":
      return `${describeValue(value.left)} ${value.op} ${describeValue(value.right)}`;
    case "unary":
      return `${value.op}${describeValue(value.operand)}`;
    case "conditional":
      return "a conditional";
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
        eachValueIn(statement.value, visit, statement.line);
        break;
      case "return":
        if (statement.value !== null) eachValueIn(statement.value, visit, statement.line);
        break;
      case "if":
        eachValueIn(statement.condition, visit, statement.line);
        eachValue(statement.then, visit);
        eachValue(statement.otherwise, visit);
        break;
      case "while":
        eachValueIn(statement.condition, visit, statement.line);
        eachValue(statement.body, visit);
        break;
      case "for":
        eachValueIn(statement.from, visit, statement.line);
        eachValueIn(statement.to, visit, statement.line);
        if (statement.step !== null) eachValueIn(statement.step, visit, statement.line);
        eachValue(statement.body, visit);
        break;
      case "print":
        statement.values.forEach((value) => eachValueIn(value, visit, statement.line));
        break;
      case "try":
        eachValue(statement.body, visit);
        if (statement.catchBody !== null) eachValue(statement.catchBody, visit);
        if (statement.finallyBody !== null) eachValue(statement.finallyBody, visit);
        break;
      case "call":
        eachValueIn(statement.value, visit, statement.line);
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
      value.args.forEach((argument) => eachValueIn(argument, visit, line));
      return;
    case "binary":
      eachValueIn(value.left, visit, line);
      eachValueIn(value.right, visit, line);
      return;
    case "unary":
      eachValueIn(value.operand, visit, line);
      return;
    case "conditional":
      eachValueIn(value.condition, visit, line);
      eachValueIn(value.then, visit, line);
      eachValueIn(value.otherwise, visit, line);
      return;
    case "index":
      eachValueIn(value.base, visit, line);
      eachValueIn(value.index, visit, line);
      return;
    case "slice":
      eachValueIn(value.base, visit, line);
      if (value.start !== null) eachValueIn(value.start, visit, line);
      if (value.stop !== null) eachValueIn(value.stop, visit, line);
      if (value.step !== null) eachValueIn(value.step, visit, line);
      return;
    case "field":
      eachValueIn(value.base, visit, line);
      return;
    case "list":
      value.items.forEach((item) => eachValueIn(item, visit, line));
      return;
    case "dict":
      value.entries.forEach((entry) => eachValueIn(entry.value, visit, line));
      return;
    case "text":
      value.parts.forEach((part) => {
        if (part.k === "value") eachValueIn(part.value, visit, line);
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
    if (value.base.k === "name" && value.base.name === "sys") found = true;
  });
  return found;
}

/**
 * The name of a list parameter whose length a body reads, or null when it
 * reads none.
 *
 * A list reaches a function as a pointer to its first element, and no length
 * arrives with it: the compiler's own C cannot answer the length of a list a
 * function was given, so a body that asks for one is refused rather than
 * compiled into something that reads past the end of it.
 */
function lengthOfAList(body: readonly PyStatement[], lists: ReadonlySet<string>): string | null {
  let found: string | null = null;
  eachValue(body, (value) => {
    if (found !== null || value.k !== "call" || value.name !== "len") return;
    if (value.args.length !== 1) return;
    const argument = value.args[0];
    if (argument.k !== "name" || !lists.has(argument.name)) return;
    found = argument.name;
  });
  return found;
}

/**
 * A Python file, read into what it declares, imports and runs.
 */
export function parsePython(source: string, path: string, diagnostics: Diagnostics): PyModule {
  const parser = new PythonParser(tokenizePython(source, path), path, diagnostics);
  return parser.parseModule();
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
    case "call": {
      if (value.name === "len" || value.name === "range") return "int";
      if (value.name === "int") return "int";
      if (value.name === "float") return "float";
      if (value.name === "str") return "text";
      if (value.name === "abs" || value.name === "min" || value.name === "max") {
        const first = value.args[0];
        return first === undefined ? "unknown" : typeOfValue(first, names);
      }
      if (value.name === "math.floor" || value.name === "math.ceil" || value.name === "math.trunc") return "int";
      if (value.name === "math.sqrt") return "float";
      if (value.name === "tl.sqrt" || value.name === "tl.math.sqrt") return "float";
      if (value.name === "tl.floor" || value.name === "tl.math.floor") return "int";
      if (value.name === "tl.ceil" || value.name === "tl.math.ceil") return "int";
      if (value.name === "tl.math.exp" || value.name === "tl.math.log" || value.name === "tl.math.sin" || value.name === "tl.math.cos") return "float";
      if (value.name === "tl.abs" || value.name === "tl.math.abs") {
        const first = value.args[0];
        return first === undefined ? "unknown" : typeOfValue(first, names);
      }
      // `tl.where` answers whichever of the two values the condition chose, so
      // the type of the answer is the type the two have in common.
      if (value.name === "tl.where" && value.args.length === 3) {
        const then = typeOfValue(value.args[1], names);
        const otherwise = typeOfValue(value.args[2], names);
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
    case "dict":
      return "dict";
    case "unary":
      return value.op === "not" ? "bool" : typeOfValue(value.operand, names);
    case "binary": {
      if (COMPARISONS.includes(value.op)) return "bool";
      // A power is always floating: `2 ** 3` is `8.0`, and a whole number is
      // read back with `int`.
      if (value.op === "**") return "float";
      const left = typeOfValue(value.left, names);
      const right = typeOfValue(value.right, names);
      if (left === "float" || right === "float") return "float";
      if (left === "int" && right === "int") return "int";
      if (left === "bool" && right === "bool") return "bool";
      return "unknown";
    }
    case "conditional": {
      const then = typeOfValue(value.then, names);
      const otherwise = typeOfValue(value.otherwise, names);
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
    return `${dottedName(value.base)}.${value.field}`;
  }
  return "";
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
      return { k: "text", parts: value.parts.map((part) => (part.k === "text" ? part : { k: "value", value: lowerValue(part.value) })) };
    case "boolean":
      return { k: "literal", text: value.value ? "1" : "0" };
    case "none":
      return { k: "null" };
    case "name":
      return { k: "ident", name: value.name };
    case "call": {
      // `len(x)` is the length of the list or of the text `x` holds, and the
      // compiler reads a length off the name it is written by.
      if (value.name === "len" && value.args.length === 1 && value.args[0].k === "name") {
        return { k: "length", buffer: value.args[0].name };
      }
      // `tl.where(c, x, y)` is a choice: the condition answers which of the two
      // values the kernel holds, and the IR carries a choice as a conditional
      // whether the source spelled it `a if c else b` or `tl.where`.
      if (value.name === "tl.where" && value.args.length === 3) {
        return {
          k: "conditional",
          condition: lowerValue(value.args[0]),
          then: lowerValue(value.args[1]),
          otherwise: lowerValue(value.args[2]),
        };
      }
      // For kernel operations not directly supported by the IR yet, still lower
      // them as calls so they can be refused later with proper diagnostics
      return { k: "call", name: builtinName(value.name), args: value.args.map(lowerValue) };
    }
    case "index":
      return { k: "index", base: lowerValue(value.base), index: lowerValue(value.index) };
    case "slice":
      return { k: "slice", base: lowerValue(value.base), start: value.start === null ? null : lowerValue(value.start), stop: value.stop === null ? null : lowerValue(value.stop), step: value.step === null ? null : lowerValue(value.step) };
    case "field":
      return { k: "member", base: lowerValue(value.base), field: value.field };
    case "list": {
      // A list written out is a buffer of the numbers it holds, and the
      // element is the width of what it holds.
      const whole = value.items.every((item) => item.k === "number" && item.whole);
      return { k: "buffer", element: whole ? "i64" : "f64", values: value.items.map(lowerValue) };
    }
    case "dict":
      return { k: "object", fields: value.entries.map((entry) => ({ name: entry.name, value: lowerValue(entry.value) })) };
    case "binary": {
      const operator = IR_OPERATORS[value.op];
      if (operator === undefined) {
        throw frontendError(`"${value.op}" is not an operator the compiler has`, "the body is refused where it is written");
      }
      return { k: "binary", op: operator, left: lowerValue(value.left), right: lowerValue(value.right) };
    }
    case "unary": {
      const operator = IR_UNARY[value.op];
      if (operator === undefined) {
        throw frontendError(`"${value.op}" is not an operator the compiler has`, "the body is refused where it is written");
      }
      return { k: "unary", op: operator, operand: lowerValue(value.operand) };
    }
    case "conditional":
      return {
        k: "conditional",
        condition: lowerValue(value.condition),
        then: lowerValue(value.then),
        otherwise: lowerValue(value.otherwise),
      };
  }
}

/** A Python statement, as the compiler's IR writes it. */
export function lowerStatement(statement: PyStatement): Statement {
  switch (statement.k) {
    case "declare":
      return { kind: "declare", name: statement.name, type: statement.type, init: lowerValue(statement.value), line: statement.line };
    case "assign":
      return {
        kind: "assign",
        target: statement.name,
        op: statement.op as AssignOperator,
        value: lowerValue(statement.value),
        line: statement.line,
      };
    case "storeField": {
      const target = statement.target as { k: "field"; base: PyValue; field: string };
      const base = target.base;
      if (base.k !== "name") {
        throw frontendError(
          '"obj.field = value" is not supported yet',
          "the object is a name the program holds",
        );
      }
      return {
        kind: "memberAssign",
        base: base.name,
        field: target.field,
        op: "=" as AssignOperator,
        value: lowerValue(statement.value),
        line: statement.line,
      };
    }
    case "return":
      return { kind: "result", value: lowerValue(statement.value ?? { k: "none" }), line: statement.line };
    case "if":
      conditionIsBoolean(statement.condition, statement.line);
      return {
        kind: "if",
        condition: lowerValue(statement.condition),
        then: statement.then.map(lowerStatement),
        otherwise: statement.otherwise.map(lowerStatement),
        line: statement.line,
      };
    case "while":
      conditionIsBoolean(statement.condition, statement.line);
      return { kind: "while", condition: lowerValue(statement.condition), body: statement.body.map(lowerStatement), line: statement.line };
    case "for":
      return {
        kind: "loop",
        variable: statement.variable,
        from: lowerValue(statement.from),
        to: lowerValue(statement.to),
        inclusive: false,
        step: statement.step === null ? null : lowerValue(statement.step),
        down: false,
        body: statement.body.map(lowerStatement),
        line: statement.line,
      };
    case "break":
      return { kind: "break", line: statement.line };
    case "continue":
      return { kind: "continue", line: statement.line };
    case "pass":
      return { kind: "expression", value: { k: "literal", text: "0" }, line: statement.line };
    case "print": {
      // A print writes its values with a space between them, and then the
      // line the console ends it with.
      const parts: TextPart[] = [];
      statement.values.forEach((value, position) => {
        if (position > 0) parts.push({ k: "text", value: " " });
        parts.push({ k: "value", value: lowerValue(value) });
      });
      return { kind: "print", value: { k: "text", parts }, line: statement.line };
    }
    case "try":
      return {
        kind: "try",
        body: statement.body.map(lowerStatement),
        catchParam: null,
        catchBody: statement.catchBody === null ? null : statement.catchBody.map(lowerStatement),
        finallyBody: statement.finallyBody === null ? null : statement.finallyBody.map(lowerStatement),
        line: statement.line,
      };
    case "call":
      return { kind: "expression", value: lowerValue(statement.value), line: statement.line };
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
    case "dict":
    case "conditional":
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
 */
const CONTRACT_OPERATORS: readonly string[] = ["+", "-", "*", "**", "//", "%", "==", "!=", "<", "<=", ">", ">="];

/**
 * The expression the result must equal, or null when the body has none: a
 * function that branches, recurses, allocates, calls or prints is contracted
 * by what it does, which `definitionContract` carries.
 */
class BodyAnalysis {
  private readonly declaration: PyFunction;
  private readonly bindings = new Map<string, string>();
  private readonly accesses: AccessRange[] = [];
  private result: string | null = null;
  /** The type each name holds, as far as the body says. */
  private readonly types = new Map<string, PyType>();

  constructor(declaration: PyFunction) {
    this.declaration = declaration;
    for (const param of declaration.params) {
      this.bindings.set(param.name, param.name);
      this.types.set(param.name, pythonTypeOf(param.type));
    }
  }

  run(): { result: string | null; accesses: AccessRange[] } {
    try {
      for (const statement of this.declaration.body) this.execute(statement, null);
    } catch (error) {
      if (!(error instanceof Uncontractable)) throw error;
      return { result: null, accesses: this.accesses };
    }
    if (this.result === null && this.declaration.returns.kind !== "void") {
      throw frontendError(
        `${this.declaration.name} never returns a value`,
        "the contract needs an expression the result must equal",
      );
    }
    return { result: this.result, accesses: this.accesses };
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
        const value = this.serialize(statement.value, loop, statement.line);
        this.bindings.set(statement.name, value);
        if (statement.type !== null) this.types.set(statement.name, pythonTypeOf(statement.type));
        else this.types.set(statement.name, typeOfValue(statement.value, this.types));
        return;
      }
      case "assign": {
        const value = this.serialize(statement.value, loop, statement.line);
        const current = this.bindings.get(statement.name);
        if (current === undefined) {
          throw frontendError(`assignment to undeclared "${statement.name}"`, `line ${statement.line}`);
        }
        const operator = statement.op === "=" ? statement.op : statement.op.slice(0, -1);
        if (statement.op !== "=" && !CONTRACT_OPERATORS.includes(operator)) {
          this.uncontractable(
            `applies "${statement.op}" to "${statement.name}"`,
            statement.line,
            "a contract is one expression the result must equal, and the contract language states + - * and the comparisons",
          );
        }
        this.bindings.set(
          statement.name,
          statement.op === "=" ? value : `(${current} ${operator} ${value})`,
        );
        return;
      }
      case "return":
        this.result = this.serialize(statement.value ?? { k: "none" }, loop, statement.line);
        return;
      case "for":
        this.executeLoop(statement);
        return;
      case "while":
        this.uncontractable("loops while a condition holds", statement.line, LOOP_REMEDY);
      case "if":
        this.uncontractable("branches", statement.line, LOOP_REMEDY);
      case "break":
        this.uncontractable("leaves a loop", statement.line, LOOP_REMEDY);
      case "continue":
        this.uncontractable("skips the rest of a loop body", statement.line, LOOP_REMEDY);
      case "try":
        this.uncontractable("uses try/except", statement.line, LOOP_REMEDY);
      case "print":
        this.uncontractable("prints", statement.line, "a contracted function returns a value and prints nothing");
      case "pass":
        return;
      case "call":
        this.uncontractable(`calls ${describeValue(statement.value)}`, statement.line, "a contracted function is computed from its parameters alone");
      case "function":
        this.uncontractable("declares a function", statement.line, LOOP_REMEDY);
    }
  }

  private executeLoop(statement: PyStatement & { k: "for" }): void {
    if (statement.step !== null) {
      this.uncontractable(
        "counts by something other than one",
        statement.line,
        "a reduction describes the range it sums over, so the index moves by one",
      );
    }
    if (statement.body.length !== 1) {
      this.uncontractable(
        "has a loop body of more than one statement",
        statement.line,
        "a reduction describes a loop that accumulates into one variable",
      );
    }
    const inner = statement.body[0];
    if (inner.k !== "assign" || (inner.op !== "+=" && inner.op !== "*=")) {
      this.uncontractable(
        "has a loop body that does not accumulate",
        statement.line,
        "a reduction describes a loop that accumulates into one variable, as in `total += a[i]`",
      );
    }
    const from = this.serialize(statement.from, null, statement.line);
    const to = this.serialize(statement.to, null, statement.line);
    const context: LoopContext = { variable: statement.variable, lo: from, hiExclusive: to };
    const body = this.serialize(inner.value, context, inner.line);
    const operator = inner.op === "*=" ? "product" : "sum";
    const reduce = `${operator}(${statement.variable} = ${from}..<${to}, ${body})`;
    const current = this.bindings.get(inner.name);
    if (current === undefined) {
      throw frontendError(`loop accumulates into undeclared "${inner.name}"`, `line ${inner.line}`);
    }
    this.bindings.set(inner.name, this.withInitial(current, reduce, operator));
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
  private serialize(value: PyValue, loop: LoopContext | null, line: number): string {
    switch (value.k) {
      case "number":
        return value.text;
      case "boolean":
        return value.value ? "true" : "false";
      case "none":
        return "null";
      case "text":
        // The contract language has no string, so a body that hands one back
        // states no postcondition.
        this.uncontractable("returns text", line, "a contract states what a function returns, which is a number");
      case "name": {
        if (loop !== null && value.name === loop.variable) return value.name;
        const bound = this.bindings.get(value.name);
        if (bound === undefined) {
          throw frontendError(`unknown identifier "${value.name}"`, `line ${line}: declare it with an initialiser`);
        }
        return bound;
      }
      case "unary": {
        if (value.op !== "-" && value.op !== "+") {
          this.uncontractable(
            `applies "${value.op}" to a value`,
            line,
            "a contract states what a function returns, which is a number",
          );
        }
        return `(${value.op}${this.serialize(value.operand, loop, line)})`;
      }
      case "binary": {
        if (!CONTRACT_OPERATORS.includes(value.op)) {
          this.uncontractable(
            `computes with ${value.op}, which a contract cannot state`,
            line,
            "the body states no postcondition, which is what a function that branches or calls has",
          );
        }
        return `(${this.serialize(value.left, loop, line)} ${value.op} ${this.serialize(value.right, loop, line)})`;
      }
      case "index": {
        if (value.base.k !== "name") {
          throw frontendError("only single level indexing is supported", `line ${line}`);
        }
        const base = value.base;
        const parameter = this.declaration.params.find((param) => param.name === base.name);
        if (parameter === undefined) {
          throw frontendError(`indexing unknown parameter "${base.name}"`, `line ${line}`);
        }
        const index = this.serialize(value.index, loop, line);
        if (loop !== null && dependsOn(value.index, loop.variable)) {
          this.accesses.push({ parameter: parameter.name, lo: loop.lo, hi: loop.hiExclusive });
        } else {
          this.accesses.push({ parameter: parameter.name, lo: index, hi: `(${index} + 1)` });
        }
        return `${parameter.name}[${index}]`;
      }
      case "slice": {
        this.uncontractable("slices a value", line, "a contracted function is computed from its parameters alone");
      }
      case "call": {
        // The contract language has one function of its own: `len(x)`, which
        // is the length of the buffer or of the text `x` holds.
        const argument = value.args.length === 1 ? value.args[0] : null;
        if (value.name === "len" && argument !== null && argument.k === "name") {
          const parameter = this.declaration.params.find((param) => param.name === argument.name);
          if (parameter === undefined) {
            throw frontendError(`the length of unknown "${argument.name}"`, `line ${line}`);
          }
          return `len(${parameter.name})`;
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
      return dependsOn(value.operand, name);
    case "binary":
      return dependsOn(value.left, name) || dependsOn(value.right, name);
    case "index":
      return dependsOn(value.base, name) || dependsOn(value.index, name);
    case "slice":
      return dependsOn(value.base, name) || (value.start !== null && dependsOn(value.start, name)) || (value.stop !== null && dependsOn(value.stop, name)) || (value.step !== null && dependsOn(value.step, name));
    case "field":
      return dependsOn(value.base, name);
    case "call":
      return value.args.some((argument) => dependsOn(argument, name));
    case "list":
      return value.items.some((item) => dependsOn(item, name));
    case "dict":
      return value.entries.some((entry) => dependsOn(entry.value, name));
    case "conditional":
      return (
        dependsOn(value.condition, name) ||
        dependsOn(value.then, name) ||
        dependsOn(value.otherwise, name)
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
function usageOf(declaration: PyFunction): {
  allocates: boolean;
  prints: boolean;
  readsArgv: boolean;
  accesses: AccessRange[];
} {
  const parameters = new Set(declaration.params.map((param) => param.name));
  const accesses: AccessRange[] = [];
  /** The range a loop index stands for, which its body reads through. */
  const loops = new Map<string, { lo: string; hi: string }>();
  let allocates = false;
  let prints = false;
  let readsArgv = false;

  /** One access, stated once however many times the body reads it. */
  const access = (parameter: string, lo: string, hi: string): void => {
    const seen = accesses.some((entry) => entry.parameter === parameter && entry.lo === lo && entry.hi === hi);
    if (!seen) accesses.push({ parameter, lo, hi });
  };

  const expression = (value: PyValue): void => {
    switch (value.k) {
      case "list":
      case "dict":
        allocates = true;
        for (const item of value.k === "list" ? value.items : value.entries.map((entry) => entry.value)) {
          expression(item);
        }
        return;
      case "call":
        for (const argument of value.args) expression(argument);
        return;
      case "binary":
        expression(value.left);
        expression(value.right);
        return;
      case "unary":
        expression(value.operand);
        return;
      case "conditional":
        expression(value.condition);
        expression(value.then);
        expression(value.otherwise);
        return;
      case "index": {
        if (value.base.k === "name" && parameters.has(value.base.name)) {
          // A buffer the body indexes is a buffer it reads, at a position the
          // contract states as a number. An index the contract language cannot
          // name leaves the position unknown.
          const loop = value.index.k === "name" ? loops.get(value.index.name) : undefined;
          if (loop !== undefined) access(value.base.name, loop.lo, loop.hi);
          else {
            const at = contractTextOf(value.index);
            if (at !== null) access(value.base.name, at, `(${at} + 1)`);
          }
        }
        expression(value.base);
        expression(value.index);
        return;
      }
      case "slice": {
        expression(value.base);
        if (value.start !== null) expression(value.start);
        if (value.stop !== null) expression(value.stop);
        if (value.step !== null) expression(value.step);
        return;
      }
      case "field":
        expression(value.base);
        return;
      case "text":
        for (const part of value.parts) {
          if (part.k === "value") expression(part.value);
        }
        return;
      case "number":
      case "boolean":
      case "none":
      case "name":
        return;
    }
  };

  const statement = (one: PyStatement): void => {
    switch (one.k) {
      case "declare":
      case "assign":
        expression(one.value);
        return;
      case "return":
        if (one.value !== null) expression(one.value);
        return;
      case "print":
        prints = true;
        for (const value of one.values) expression(value);
        return;
      case "if":
        expression(one.condition);
        one.then.forEach(statement);
        one.otherwise.forEach(statement);
        return;
      case "while":
        expression(one.condition);
        one.body.forEach(statement);
        return;
      case "for": {
        expression(one.from);
        expression(one.to);
        if (one.step !== null) expression(one.step);
        // The index of a counted loop stands for the whole range the loop
        // walks, so a buffer its body reads is read over that range.
        const from = contractTextOf(one.from);
        const to = contractTextOf(one.to);
        const outer = loops.get(one.variable);
        if (from !== null && to !== null) loops.set(one.variable, { lo: from, hi: to });
        one.body.forEach(statement);
        if (outer === undefined) loops.delete(one.variable);
        else loops.set(one.variable, outer);
        return;
      }
      case "try":
        one.body.forEach(statement);
        if (one.catchBody !== null) one.catchBody.forEach(statement);
        if (one.finallyBody !== null) one.finallyBody.forEach(statement);
        return;
      case "call":
        expression(one.value);
        return;
      case "break":
      case "continue":
      case "pass":
      case "function":
        return;
    }
  };

  declaration.body.forEach(statement);
  return { allocates, prints, readsArgv, accesses };
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
      if (value.name === "len" && value.args.length === 1 && value.args[0].k === "name") {
        return `len(${value.args[0].name})`;
      }
      return null;
    case "unary":
      if (value.op !== "-" && value.op !== "+") return null;
      const operand = contractTextOf(value.operand);
      return operand === null ? null : `(${value.op}${operand})`;
    case "binary": {
      if (!CONTRACT_OPERATORS.includes(value.op)) return null;
      const left = contractTextOf(value.left);
      const right = contractTextOf(value.right);
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
      return conversionInValue(statement.value);
    case "return":
      return statement.value === null ? null : conversionInValue(statement.value);
    case "if":
      return (
        conversionInValue(statement.condition) ??
        conversionIn(statement.then) ??
        conversionIn(statement.otherwise)
      );
    case "while":
      return conversionInValue(statement.condition) ?? conversionIn(statement.body);
    case "for":
      return (
        conversionInValue(statement.from) ??
        conversionInValue(statement.to) ??
        conversionIn(statement.body)
      );
    case "print":
      return statement.values.map(conversionInValue).find((found) => found !== null) ?? null;
    case "try":
      return (
        conversionIn(statement.body) ??
        (statement.catchBody === null ? null : conversionIn(statement.catchBody)) ??
        (statement.finallyBody === null ? null : conversionIn(statement.finallyBody))
      );
    case "call":
      return conversionInValue(statement.value);
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
      return value.args.map(conversionInValue).find((found) => found !== null) ?? null;
    }
    case "binary":
      return conversionInValue(value.left) ?? conversionInValue(value.right);
    case "unary":
      return conversionInValue(value.operand);
    case "conditional":
      return (
        conversionInValue(value.condition) ??
        conversionInValue(value.then) ??
        conversionInValue(value.otherwise)
      );
    case "index":
      return conversionInValue(value.base) ?? conversionInValue(value.index);
    case "slice":
      return (
        conversionInValue(value.base) ??
        (value.start === null ? null : conversionInValue(value.start)) ??
        (value.stop === null ? null : conversionInValue(value.stop)) ??
        (value.step === null ? null : conversionInValue(value.step))
      );
    case "field":
      return conversionInValue(value.base);
    case "list":
      return value.items.map(conversionInValue).find((found) => found !== null) ?? null;
    case "dict":
      return value.entries.map((entry) => conversionInValue(entry.value)).find((found) => found !== null) ?? null;
    case "text":
      return value.parts
        .filter((part): part is { k: "value"; value: PyValue } => part.k === "value")
        .map((part) => conversionInValue(part.value))
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
export const pythonFrontend: Frontend = {
  analyze(source, path): ModuleAnalysis {
    if (typeof source !== "string" || source.trim() === "") {
      throw frontendError(`module ${path} is empty`);
    }
    const diagnostics = new Diagnostics();
    const parsed = parsePython(source, path, diagnostics);
    // A call of a name the compiler does not know is refused, as it is for a
    // TypeScript module: the subset is a list of the names a file may call,
    // and a name outside it is a name the compiler cannot compile.
    const known = new Set<string>(parsed.functions.map((declaration) => declaration.name));
    for (const imported of parsed.imports) {
      for (const name of imported.names ?? []) known.add(name);
    }
    // A file that holds statements is a program, and a program has the
    // conversions and the roundings a module of functions has not.
    const builtins = parsed.body.length === 0 ? MODULE_BUILTINS : PYTHON_BUILTINS;
    const calls = new Map<string, number>();
    for (const declaration of parsed.functions) callsOf(declaration.body, calls);
    for (const statement of parsed.body) {
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
    const functions: DeclaredFunction[] = parsed.functions.map((declaration) => ({
      name: declaration.name,
      // Every function of a Python module is part of its interface: a name
      // that starts with an underscore is a convention, not a rule the
      // compiler reads.
      exported: true,
      params: declaration.params.map((param) => ({ name: param.name, type: param.type })),
      returns: declaration.returns,
      handle: declaration,
    }));
    // A file is a program when it has a top level statement that is not a
    // definition: the statements the entry module runs are the program, and
    // everything else the file declares is a library of functions.
    const body = parsed.body.length === 0 ? [] : lowerProgramBody(parsed.body);
    return {
      path,
      imports: parsed.imports,
      functions,
      default: null,
      body,
      entryGuard: parsed.entryGuard && parsed.body.length > 0,
    };
  },

  contractFor(analysis, declared, input) {
    const declaration = declared.handle as PyFunction;
    // A module is a library of functions, and a library reads no command line:
    // the command line is read by the program, which is the statements of the
    // entry module.
    if (readsCommandLine(declaration.body)) {
      throw frontendError(
        `${declaration.name} reads the command line, which a module may not`,
        `line ${declaration.line} of ${analysis.path}: the command line is read by the program, as in \`sys.argv\` in the statements of the entry module`,
      );
    }
    // A conversion is a program of its own: `int(x)` answers a whole number
    // and `str(x)` a text, and a module of functions has neither.
    if (analysis.body.length === 0) {
      const conversion = conversionIn(declaration.body);
      if (conversion !== null) {
        throw frontendError(
          `"${conversion}" is not part of a module`,
          `line ${declaration.line} of ${analysis.path}: a module is a library of functions, and a conversion is a program of its own`,
        );
      }
    }
    // The length of a list a function was given is not read: the list
    // arrives as a pointer to its first element, and no length arrives with
    // it.
    const lists = new Set(
      declaration.params.filter((param) => param.type.kind === "slice" || param.type.kind === "array").map((param) => param.name),
    );
    const length = lengthOfAList(declaration.body, lists);
    if (length !== null) {
      throw frontendError(
        `${declaration.name} reads the length of a list, which the compiler does not carry`,
        `line ${declaration.line} of ${analysis.path}: a list reaches a function as a pointer to its first element and no length arrives with it; take the length as a parameter of its own, as in def dot(a: list[float], n: int) -> float:`,
      );
    }
    const body = new BodyAnalysis(declaration).run();
    const usage = usageOf(declaration);
    return assembleContract({
      name: declaration.name,
      params: declaration.params.map((param) => ({ name: param.name, type: param.type })),
      returns: declaration.returns,
      result: body.result,
      accesses: usage.accesses,
      definition: {
        statements: declaration.body.map(lowerStatement),
        allocates: usage.allocates,
        prints: usage.prints,
        readsArgv: usage.readsArgv,
      },
      input,
    });
  },

  resolveImport(specifier) {
    if (specifier === "") {
      throw frontendError("cannot import nothing", "a module imports the functions of another file of the project");
    }
    if (specifier.includes(".")) {
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

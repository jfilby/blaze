/**
 * The IR a compiled function is written in.
 *
 * A frontend parses a source language into these statements and expressions,
 * the contract phase carries them in every function's contract, and both the
 * function resolver and the driver emitter read the same ones. Nothing here
 * names a source language, so a contract stays language neutral.
 */

import type { TypeExpr } from "./types.ts";

/** Operators a function body or a program statement may use. */
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<<"
  | ">>"
  | ">>>"
  | "&"
  | "|"
  | "^"
  | "<"
  | "<="
  | ">"
  | ">="
  | "**"
  | "==="
  | "!=="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "??";

export type UnaryOp = "-" | "+" | "!" | "~";

/** One piece of a string: text as written, or a value interpolated into it. */
export type TextPart = { k: "text"; value: string } | { k: "value"; value: Expression };

/**
 * The expression a function body or a program statement is written in. It is
 * the language-neutral IR the contract phase and the driver emitter both read,
 * so what the frontend accepts is exactly what travels on.
 */
export type Expression =
  | { k: "literal"; text: string }
  | { k: "bigint"; text: string }
  | { k: "ident"; name: string }
  | { k: "null" }
  /** `process.argv`, or one of its arguments. */
  | { k: "argv"; index: Expression | null }
  | { k: "length"; buffer: string }
  | { k: "index"; base: Expression; index: Expression }
  | { k: "member"; base: Expression; field: string }
  | { k: "call"; name: string; args: Expression[] }
  | { k: "object"; fields: { name: string; value: Expression }[] }
  /**
   * `new Float64Array(n)`: a typed array of a count the program settles on when
   * it runs. `element` is the contract type its elements are held at, which is
   * the view written, so an `Int32Array` is four bytes an element and not eight.
   */
  | { k: "sized"; element: string; count: Expression }
  /** `new Float64Array([1, 2, 3])`: a typed array of the elements written out. */
  | { k: "buffer"; element: string; values: Expression[] }
  /** A template string: text as written, with the values it interpolates. */
  | { k: "text"; parts: TextPart[] }
  /**
   * `x.toFixed(d)`: the number written as text at `d` digits after the point.
   * The count is written out in the source, so it is a number the parser reads
   * rather than a value it evaluates — the same reason the program body reads it
   * that way.
   */
  | { k: "fixed"; of: Expression; digits: number }
  | { k: "binary"; op: BinaryOp; left: Expression; right: Expression }
  | { k: "unary"; op: UnaryOp; operand: Expression }
  | { k: "conditional"; condition: Expression; then: Expression; otherwise: Expression }
  /** `i++` as a value: the old value of `name`, after the change. */
  | { k: "update"; name: string; op: "++" | "--"; prefix: boolean };

export type AssignOperator = "=" | "+=" | "*=" | "-=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | ">>>=" | "**=";

export type Statement =
  | { kind: "declare"; name: string; type: TypeExpr | null; init: Expression; line: number }
  | {
      kind: "loop";
      variable: string;
      from: Expression;
      to: Expression;
      inclusive: boolean;
      /** The step as written, or null for the implicit one. */
      step: Expression | null;
      down: boolean;
      body: Statement[];
      line: number;
    }
  | { kind: "assign"; target: string; op: AssignOperator; value: Expression; line: number }
  | { kind: "memberAssign"; base: string; field: string; op: AssignOperator; value: Expression; line: number }
  | { kind: "update"; name: string; op: "++" | "--"; prefix: boolean; line: number }
  | { kind: "result"; value: Expression; line: number }
  | { kind: "if"; condition: Expression; then: Statement[]; otherwise: Statement[]; line: number }
  | { kind: "while"; condition: Expression; body: Statement[]; line: number }
  | { kind: "doWhile"; condition: Expression; body: Statement[]; line: number }
  /** Walks the elements of a parameter, as in `for (const x of values)`. */
  | { kind: "forOf"; variable: string; of: string; body: Statement[]; line: number }
  | { kind: "break"; line: number }
  | { kind: "continue"; line: number }
  | { kind: "print"; value: Expression; line: number }
  /** A call kept for what it does, as in `main();`. */
  | { kind: "expression"; value: Expression; line: number }
  /** An element written, by `=` or by one of the compound operators. */
  | { kind: "indexAssign"; buffer: string; index: Expression; op: AssignOperator; value: Expression; line: number };

/** Every operator `op=` accepts, and the operator it applies. */
export const COMPOUND_OPERATORS: Record<string, BinaryOp> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "%=": "%",
  "&=": "&",
  "|=": "|",
  "^=": "^",
  "<<=": "<<",
  ">>=": ">>",
  ">>>=": ">>>",
  "**=": "**",
};

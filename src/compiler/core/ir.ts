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
  /** A floor division, as Python writes it: the quotient moved down one. */
  | "//"
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
  | { k: "slice"; base: Expression; start: Expression | null; stop: Expression | null; step: Expression | null }
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
  | { k: "update"; name: string; op: "++" | "--"; prefix: boolean }
  /**
   * An arrow function the source wrote, and the function it was lifted to.
   *
   * The frontend lifts an arrow's body into a function of the file. Called by
   * the name it is bound to, the call is rewritten to a call of that function
   * with the values it captured written in front; read as a value, it is a
   * closure carrying those values, which `code` enters.
   */
  | {
      k: "arrow";
      /** The function the arrow was lifted to. */
      name: string;
      /**
       * The names the arrow reads from the function around it, in the order the
       * lifted function takes them.
       */
      captures: string[];
      /**
       * The function an arrow is entered by when it is called as a value.
       *
       * A lifted body takes the values it captured as leading parameters, which
       * a call site that has them can write. A call site that holds the arrow in
       * a name only has the arrow, so the captured values travel with it and are
       * unpacked here: `code` is a function of the file whose first parameter is
       * the closure and whose remaining parameters are the arrow's own.
       *
       * It is absent where the arrow is only ever called by the name it is bound
       * to, which needs no closure at all.
       */
      code?: string;
    }
  /**
   * One value a closure captured, read out of the closure it travels in.
   *
   * `closure` is the closure as a value, `index` is the position of the capture
   * in the order the arrow first read it, and `type` is the type it is read at.
   */
  | { k: "capture"; closure: Expression; index: number; type: TypeExpr }
  /**
   * A call of a value, as `f(x)` where `f` holds a function rather than naming
   * one.
   *
   * The signature is the one written at the call site, because a value does not
   * carry the types of its parameters: `params[i]` is the type the argument at
   * `i` is handed over as, and `returns` is what the call answers.
   */
  | { k: "invoke"; callee: Expression; args: Expression[]; params: TypeExpr[]; returns: TypeExpr };

export type AssignOperator = "=" | "+=" | "*=" | "-=" | "/=" | "//=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | ">>>=" | "**=";

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
  /** A value the source raises: the program ends here and answers nothing. */
  | { kind: "throw"; value: Expression; line: number }
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
  | { kind: "indexAssign"; buffer: string; index: Expression; op: AssignOperator; value: Expression; line: number }
  | { kind: "try"; body: Statement[]; catchParam: string | null; catchBody: Statement[] | null; finallyBody: Statement[] | null; line: number };

/** Every operator `op=` accepts, and the operator it applies. */
export const COMPOUND_OPERATORS: Record<string, BinaryOp> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "//=": "//",
  "%=": "%",
  "&=": "&",
  "|=": "|",
  "^=": "^",
  "<<=": "<<",
  ">>=": ">>",
  ">>>=": ">>>",
  "**=": "**",
};

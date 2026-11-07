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
  /**
   * A number. `boolean` is set on `0` and `1` the source wrote as `false` and
   * `true`: the value is the number the language holds a truth as, and the
   * field it is written into is a truth.
   */
  | { k: "literal"; text: string; boolean?: true }
  | { k: "bigint"; text: string }
  | { k: "ident"; name: string }
  | { k: "null" }
  /** `process.argv`, or one of its arguments. */
  | { k: "argv"; index: Expression | null }
  | { k: "length"; buffer: string }
  /**
   * The length of a value written where no name holds it, as `a[0].length` and
   * `f().length` are. A name that is already held is `length` above.
   */
  | { k: "lengthOf"; of: Expression }
  | { k: "index"; base: Expression; index: Expression }
  | { k: "slice"; base: Expression; start: Expression | null; stop: Expression | null; step: Expression | null }
  | { k: "member"; base: Expression; field: string }
  /**
   * A call of a name.
   *
   * `returns` is what the read of the call knows it answers, where that is
   * more than the builtin states: `m.get(k)` over a map of lists answers the
   * list the map holds, and the runtime function it lowers to answers the
   * block the list is. Nothing but a builtin the read has typed itself writes
   * it.
   */
  | { k: "call"; name: string; args: Expression[]; returns?: TypeExpr }
  | {
      k: "object";
      fields: { name: string; value: Expression }[];
      /**
       * The fields the source wrote, where `fields` holds more than those: an
       * object at a union of shapes is laid out as every arm, and the fields
       * the source did not write are the zero the layout needs.
       */
      written?: readonly string[];
    }
  /**
   * `new Float64Array(n)`: a typed array of a count the program settles on when
   * it runs. `element` is the contract type its elements are held at, which is
   * the view written, so an `Int32Array` is four bytes an element and not eight.
   */
  | { k: "sized"; element: string; count: Expression }
  /**
   * `new Float64Array([1, 2, 3])`: a typed array of the elements written out,
   * or — with a `view` — a window of a block another value holds, as
   * `bytes.subarray(from, to)` writes. A view is the block it looks into rather
   * than a block of its own, and how many elements it holds is what it was
   * taken of, from the offset it starts at.
   */
  | {
      k: "buffer";
      element: string;
      values: Expression[];
      view?: { of: Expression; offset: Expression; count: Expression };
    }
  /** A template string: text as written, with the values it interpolates. */
  | { k: "text"; parts: TextPart[] }
  /**
   * `x.toFixed(d)`: the number written as text at `d` digits after the point.
   * The count is written out in the source, so it is a number the parser reads
   * rather than a value it evaluates — the same reason the program body reads it
   * that way.
   */
  | { k: "fixed"; of: Expression; digits: number; precision?: true }
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
  | { k: "invoke"; callee: Expression; args: Expression[]; params: TypeExpr[]; returns: TypeExpr }
  /**
   * `a.push(x)` and `a.pop()`: a change to the array the name holds.
   *
   * An array here is a block and a length, and growing one is a block of its
   * own, so a push answers the array the name has afterwards. It is therefore a
   * statement and not a value: written for what it does, it is the assignment
   * the frontend writes; written for what it answers, there is nothing to give.
   */
  | {
      k: "append";
      /** The array name, or the field of `base` the append is written on. */
      target: string;
      /** The name the target field belongs to, or null where the target is a name. */
      base: string | null;
      /**
       * The element of `target` the append is written on, as `a[i].push(x)`
       * writes it. The element is written back where the array is the element
       * of another one: a push answers the list it was written on, and the
       * block that holds it is the write the statement keeps.
       */
      index?: Expression;
      helper: string;
      op: "push" | "pop";
      /** The values a push adds, in the order it writes them; a pop adds none. */
      values: Expression[];
      /**
       * Which of the values the source spread with `...`, aligned with
       * `values`. A spread value is a list already and joins the ones in front
       * of it, which is the concatenation two lists added are.
       */
      spreads?: readonly boolean[];
      /** The element type of the array, which a written value is joined at. */
      element?: TypeExpr;
      /**
       * The two places a conditional names, as `(c ? a : b).push(x)` writes
       * them. The push is the push on whichever the condition chooses, so the
       * statement it becomes is the `if` over the two writes.
       */
      arms?: readonly { target: string; base: string | null }[];
      /** The condition that chooses between `arms`. */
      condition?: Expression;
    };

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
  | { kind: "result"; value: Expression | null; line: number }
  /** A value the source raises: the program ends here and answers nothing. */
  | { kind: "throw"; value: Expression; line: number }
  | { kind: "if"; condition: Expression; then: Statement[]; otherwise: Statement[]; line: number }
  | { kind: "while"; condition: Expression; body: Statement[]; line: number }
  | { kind: "doWhile"; condition: Expression; body: Statement[]; line: number }
  /** Walks the elements of a parameter, as in `for (const x of values)`. */
  | { kind: "forOf"; variable: string; of: string; body: Statement[]; line: number }
  | { kind: "break"; line: number }
  | { kind: "continue"; line: number }
  | {
      kind: "print";
      value: Expression;
      line: number;
      /**
       * Whether the line ends after the value. `console.log` ends it and
       * `process.stdout.write` does not, which is the whole difference between
       * the two.
       */
      newline?: boolean;
    }
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

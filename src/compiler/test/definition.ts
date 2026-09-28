/**
 * The body a hand-built contract carries.
 *
 * Every function the compiler contracts has one, whether or not a postcondition
 * also says what its result must equal, so a fixture contract states its
 * statements as well as its signature and its conditions. These build those
 * statements: the units under test below read a signature, a postcondition and
 * a layout, and the body here is what the contract says the function is.
 */

import type { Expression, Statement } from "../core/ir.ts";
import type { FunctionDefinition, ObjectLayout } from "../core/types.ts";

/** A function of a few statements and the objects they lay out. */
export function body(
  statements: readonly Statement[],
  objects: Record<string, ObjectLayout> = {},
): FunctionDefinition {
  return { statements: [...statements], objects, allocates: false, prints: false, readsArgv: false, calls: [] };
}

/** A body that returns one value, which is what a function whose result is one expression carries. */
export function returns(value: Expression, objects: Record<string, ObjectLayout> = {}): FunctionDefinition {
  return body([{ kind: "result", value, line: 1 }], objects);
}

/** The number `0`, as a contract type spells it. */
export const ZERO: Expression = { k: "literal", text: "0.0" };

/**
 * The body of a dot product over two arrays: it sums the products of the
 * elements it reads. Three fixtures state the reduction `sum(i = 0..<n,
 * a[i] * b[i])`, and this is the one body that says it.
 */
export function dotProductBody(): FunctionDefinition {
  return body([
    {
      kind: "loop",
      variable: "i",
      from: { k: "literal", text: "0" },
      to: { k: "ident", name: "n" },
      inclusive: false,
      step: null,
      down: false,
      line: 2,
      body: [
        {
          kind: "assign",
          target: "sum",
          op: "+=",
          line: 2,
          value: {
            k: "binary",
            op: "*",
            left: { k: "index", base: { k: "ident", name: "a" }, index: { k: "ident", name: "i" } },
            right: { k: "index", base: { k: "ident", name: "b" }, index: { k: "ident", name: "i" } },
          },
        },
      ],
    },
    { kind: "result", value: { k: "ident", name: "sum" }, line: 3 },
  ]);
}

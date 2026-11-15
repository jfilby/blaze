function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** The elements a list value holds. */
function itemsOf(value: PyValue): PyValue[] {
  return fieldOf(value, "items") as PyValue[];
}

/** Whether every element of a list is a member of a set. */
function allIn(items: readonly PyValue[], set: SparseSet): boolean {
  for (const item of items) if (!set.has(item)) return false;
  return true;
}

function valuesOf(bindings: unknown): Map<string, PyValue> {
  return fieldOf(bindings, "values") as Map<string, PyValue>;
}

function dictsOf(bindings: unknown): Map<string, Set<string>> {
  return fieldOf(bindings, "dicts") as Map<string, Set<string>>;
}

function valueAt(bindings: unknown, name: string): PyValue | undefined {
  return valuesOf(bindings).get(name);
}

function hasValue(bindings: unknown, name: string): boolean {
  return valuesOf(bindings).has(name);
}

function setValue(bindings: unknown, name: string, value: PyValue): void {
  valuesOf(bindings).set(name, value);
}

function deleteValue(bindings: unknown, name: string): void {
  valuesOf(bindings).delete(name);
}

function valueNames(bindings: unknown): string[] {
  const out: string[] = [];
  for (const name of valuesOf(bindings).keys()) out[out.length] = name;
  return out;
}

function dictOf(bindings: unknown, name: string): Set<string> | undefined {
  return dictsOf(bindings).get(name);
}

function hasDict(bindings: unknown, name: string): boolean {
  return dictsOf(bindings).has(name);
}

function setDict(bindings: unknown, name: string, keys: Set<string>): void {
  dictsOf(bindings).set(name, keys);
}

function deleteDict(bindings: unknown, name: string): void {
  dictsOf(bindings).delete(name);
}

/**
 * Frontend: the statements a Python module runs.
 *
 * A module is either a library of functions or a program. This file reads the
 * program: the statements of the entry module, in the order they run. A
 * program is not contracted — the contract phase (see program.ts) keeps it as
 * the program and the driver the compiler emits runs it — so what is read here
 * is the source language, not anything a contract can state:
 *
 *   from helpers import dot
 *
 *   def main() -> int:
 *       a = [1.0, 2.0, 3.0]
 *       b = [4.0, 5.0, 6.0]
 *       print(dot(a, b))
 *       return 0
 *
 *   if __name__ == "__main__":
 *       main()
 *
 * The values a program holds are the program's own: a number, a text, a
 * boolean, a nothing, a name, a call, an element, a field, a list, a dict and
 * the operators over them.
 */

import type {
  ProgramAssignOp,
  ProgramBinaryOp,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "./module.ts";
import type { PrimitiveTypeName } from "../core/types.ts";
import type { PyStatement, PyTextPart, PyValue } from "./python.ts";
import { builtinName, conditionIsBoolean, describeValue, typeOfValue } from "./python.ts";
import { frontendError } from "./diagnostics.ts";
import { BitSet } from "../util/sets.ts";

/** The operators a program value may use, as Python writes them. */
const BINARY_OPERATORS: Record<string, ProgramBinaryOp> = {
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

/** The operators a value may be written with, in front of it. */
const UNARY_OPERATORS: Record<string, ProgramUnaryOp> = {
  "-": "-",
  "+": "+",
  "~": "~",
  not: "!",
};

/** The compound assignments a name may be given. */
const ASSIGN_OPERATORS: Record<string, ProgramAssignOp> = {
  "+=": "+=",
  "-=": "-=",
  "*=": "*=",
  "/=": "/=",
  "//=": "//=",
  "%=": "%=",
};

/**
 * What the names a program body binds hold, as far as the body says.
 *
 * A dict is an object, and its fields are read by their key: `d["key"]` is a
 * field of the object the name holds, and not an element of a buffer. The
 * keys a dict holds are what says which of the two a read is, so they are
 * carried with the name.
 */
interface Bindings {
  /** The names that hold a dict, and the keys each of them holds. */
  readonly dicts: Map<string, Set<string>>;
  /** The values names hold, for evaluating comprehensions. */
  readonly values: Map<string, PyValue>;
}

/** The bindings of a program body that holds nothing yet. */
function noBindings(): Bindings {
  return { dicts: new Map(), values: new Map() };
}
function cloneBindings(b: Bindings): Bindings {
  const values = fieldOf(b, "values") as Map<string, PyValue>;
  return { dicts: new Map(b.dicts), values: new Map(values) };
}

/**
 * A Python value, as the program model holds it.
 *
 * A whole number is a whole number of the program model: the kind a TypeScript
 * source writes `1n` for, which is the `i64` a Python `int` is. A fraction is
 * a number, which is a double.
 */
/**
 * A sparse set: a dense array of elements plus a sparse map from an element's
 * key to its index in the dense array. Membership, insertion and removal are
 * answered in constant time, and the dense array keeps the elements in the order
 * they were inserted.
 *
 * This is the classic sparse-set trick, generalised to arbitrary keys through
 * a map: the dense array is the set's contents, and the sparse map is the
 * inverse of it. A key is in the set exactly when its sparse entry points at a
 * dense slot that still holds it.
 */
class SparseSet {
  private dense: PyValue[] = [];
  private sparse: Map<string, number> = new Map();

  private keyOf(value: PyValue): string {
    return value.k === "number" ? `n:${value.text}` : JSON.stringify(value);
  }

  has(value: PyValue): boolean {
    const key = this.keyOf(value);
    const index = this.sparse.get(key);
    if (index === undefined) return false;
    return index < fieldOf(this, "dense").length && this.keyOf(fieldOf(this, "dense")[index]) === key;
  }

  add(value: PyValue): boolean {
    if (this.has(value)) return false;
    this.sparse.set(this.keyOf(value), fieldOf(this, "dense").length);
    this.dense.push(value);
    return true;
  }

  remove(value: PyValue): boolean {
    const key = this.keyOf(value);
    const index = this.sparse.get(key);
    const dense = fieldOf(this, "dense") as PyValue[];
    if (index === undefined || index >= dense.length || this.keyOf(dense[index]) !== key) return false;
    const last = dense[dense.length - 1];
    dense[index] = last;
    this.sparse.set(this.keyOf(last), index);
    dense.pop();
    this.sparse.delete(key);
    return true;
  }

  toArray(): PyValue[] {
    const dense = fieldOf(this, "dense") as PyValue[];
    return dense.slice();
  }

  get size(): number {
    return fieldOf(this, "dense").length;
  }

  clear(): void {
    this.dense = [];
    this.sparse.clear();
  }
}

function programValue(one: PyValue, bindings: Bindings): ProgramValue {
  if (one.k === "name" && hasValue(bindings, String(String(fieldOf(one, "name"))))) {
    return programValue(valueAt(bindings, String(String(fieldOf(one, "name"))))!, bindings);
  }
  switch (one.k) {
    case "number":
      return one.whole ? { k: "whole", text: one.text } : { k: "number", text: one.text };
    case "text":
      return { k: "text", parts: text(fieldOf(one, "parts"), bindings) };
    case "boolean":
      return { k: "boolean", value: fieldOf(one, "value") === true };
    case "none":
      return { k: "null" };
    case "name":
      return { k: "name", name: String(fieldOf(one, "name")) };
    case "await":
      // `await v` is the value the promise `v` carries, which the program body
      // reads where it is written.
      return { k: "call", function: "Promise.await", args: [programValue(fieldOf(one, "value") as PyValue, bindings)] };
    case "call": {
      // A name bound to a function (a lambda) is called by inlining its body
      // with the arguments bound to its parameters.
      if (String(fieldOf(one, "name")) !== "len" && String(fieldOf(one, "name")) !== "str" && String(fieldOf(one, "name")) !== "tl.where" && hasValue(bindings, String(String(fieldOf(one, "name"))))) {
        const fn = valueAt(bindings, String(String(fieldOf(one, "name"))))!;
        if (fn.k === "lambda") {
          const child = cloneBindings(bindings);
          const callParams = fieldOf(fn, "params") as readonly { readonly name: string }[];
          const callArgs = fieldOf(one, "args") as readonly PyValue[];
          for (let idx = 0; idx < callParams.length; idx++) {
            if (idx < callArgs.length) setValue(child, String(fieldOf(callParams[idx], "name")), callArgs[idx]);
          }
          // Inline: evaluate the body (single expression).
          return programValue(fn.body, child);
        }
      }
      // `len(x)` is the length of the list or of the text `x` holds, and the
      // program model reads a length off the name it is written by.
      const lenArgs = fieldOf(one, "args") as PyValue[];
      if (String(fieldOf(one, "name")) === "len" && lenArgs.length === 1 && lenArgs[0].k === "name") {
        return { k: "length", of: fieldOf(lenArgs[0], "name") };
      }
      // The length of the command line is the length of the list of texts
      // Python holds, which is the file the program runs and the arguments it
      // was given.
      const argvArgs = fieldOf(one, "args") as PyValue[];
      if (String(fieldOf(one, "name")) === "len" && argvArgs.length === 1 && isSysArgv(argvArgs[0])) {
        return { k: "call", function: "argvLength", args: [] };
      }
      // The length of a text written out is the length of a name: the program
      // model reads a length off the name it is written by, and a text written
      // out is not one.
      if (String(fieldOf(one, "name")) === "len" && fieldOf(one, "args").length === 1) {
        throw frontendError(
          "the length of a value written out is not read",
          "write the value into a name and take the length of that, as in `s = 'hello'` and then `len(s)`",
        );
      }
      // `str(x)` is the text of the value, which the runtime writes.
      if (String(fieldOf(one, "name")) === "str" && fieldOf(one, "args").length === 1) {
        return { k: "text", parts: [{ k: "value", value: programValue(fieldOf(one, "args")[0], bindings) }] };
      }
      // `tl.where(c, x, y)` is the choice the program model writes, whether the
      // source spelled it `x if c else y` or `tl.where`.
      const whereArgs = fieldOf(one, "args") as readonly PyValue[];
      if (String(fieldOf(one, "name")) === "tl.where" && whereArgs.length === 3) {
        return {
          k: "conditional",
          condition: programValue(whereArgs[0], bindings),
          then: programValue(whereArgs[1], bindings),
          otherwise: programValue(whereArgs[2], bindings),
        };
      }
      if (fieldOf(one, "grid") !== undefined) {
        return { k: "call", function: builtinName(String(fieldOf(one, "name"))), args: one.args.map((argument) => programValue(argument, bindings)), grid: programValue((one as any).grid, bindings) } as any;
      }
      return { k: "call", function: builtinName(String(fieldOf(one, "name"))), args: one.args.map((argument) => programValue(argument, bindings)) };
    }
    case "index": {
      // `sys.argv[i]` is the command line of the program: the compiler counts
      // the program and the file it runs before the arguments, and Python
      // counts the file alone, so the argument a Python program reads at `i`
      // is the one the compiler holds at `i + 1`.
      if (isSysArgv(fieldOf(one, "base"))) {
        return { k: "argv", index: programValue(fieldOf(one, "index"), bindings), offset: 1 };
      }
      // A dict is an object, and its fields are read by their key: `d["key"]`
      // is a field of the object the name holds, and not an element of a
      // buffer of numbers.
      if (fieldOf(one, "base").k === "name" && fieldOf(one, "index").k === "text") {
        const keys = dictOf(bindings, String(fieldOf(fieldOf(one, "base"), "name")));
        if (keys !== undefined) {
          const key = textOf(fieldOf(one, "index"));
          if (key === null) {
            throw frontendError(
              "the key of a dict is written as it is",
              "a dict is read by the key it was written with, as in d[\"left\"]",
            );
          }
          if (!keys.has(key)) {
            throw frontendError(
              `the dict holds no key "${key}"`,
              `the keys it holds are ${[...keys].map((held) => `"${held}"`).join(", ")}`,
            );
          }
          return { k: "field", object: { k: "name", name: fieldOf(one, "base").name }, field: key };
        }
      }
      // A slice produces a buffer, and indexing into it is resolved at compile
      // time when the slice and the index are both constant.
      if (fieldOf(one, "base").k === "slice") {
        const sliced = programValue(fieldOf(one, "base"), bindings);
        if (sliced.k !== "buffer") {
          throw frontendError(
            `a program cannot read an element of ${describeValue(one.base)}`,
            "a list is read by its index, as in a[0]",
          );
        }
        let idx: number;
        const index = fieldOf(one, "index");
        const indexLeft = fieldOf(index, "left");
        const indexArgs = fieldOf(indexLeft, "args") as readonly { readonly k: string }[];
        const indexRight = fieldOf(index, "right");
        if (index.k === "number") {
          idx = Number(fieldOf(index, "text"));
        } else if (index.k === "unary" && String(fieldOf(index, "op")) === "-") {
          const operand = fieldOf(index, "operand");
          const n = operand.k === "number" ? Number(fieldOf(operand, "text")) : 0;
          idx = fieldOf(sliced, "values").length - n;
        } else if (
          index.k === "binary" && String(fieldOf(index, "op")) === "-" &&
          indexLeft.k === "call" && String(fieldOf(indexLeft, "name")) === "len" &&
          indexArgs.length === 1 && indexArgs[0].k === "slice"
        ) {
          // The parser converted a[-n] to a[len(a)-n]; resolve it using
          // the slice's known length.
          const n = indexRight.k === "number" ? Number(fieldOf(indexRight, "text")) : 0;
          idx = fieldOf(sliced, "values").length - n;
        } else {
          // Try evaluating the index.
          const indexValue = programValue(fieldOf(one, "index"), bindings);
          if (indexValue.k === "whole" || indexValue.k === "number") {
            idx = Number(indexValue.text);
          } else {
            throw frontendError(
              `a program cannot read an element of ${describeValue(one.base)} with a non-constant index`,
              "a list is read by its index, as in a[0]",
            );
          }
        }
        if (idx < 0 || idx >= fieldOf(sliced, "values").length) {
          throw frontendError(
            `index ${idx} is out of range for a slice of length ${sliced.values.length}`,
            "a list is read by its index, as in a[0]",
          );
        }
        return fieldOf(sliced, "values")[idx];
      }
      // A list literal is indexed directly.
      if (String(fieldOf(fieldOf(one, "base"), "k")) === "list") {
        const items = fieldOf(fieldOf(one, "base"), "items") as readonly PyValue[];
        const indexValue = programValue(fieldOf(one, "index"), bindings);
        let idx: number;
        if (indexValue.k === "whole" || indexValue.k === "number") {
          idx = Number(indexValue.text);
        } else {
          const index = fieldOf(one, "index");
          if (index.k === "unary" && String(fieldOf(index, "op")) === "-") {
            const operand = fieldOf(index, "operand");
            const n = operand.k === "number" ? Number(fieldOf(operand, "text")) : 0;
            idx = items.length - n;
          } else {
            throw frontendError(
              `a program cannot read an element of a list with a non-constant index`,
              "a list is read by its index, as in a[0]",
            );
          }
        }
        if (idx < 0 || idx >= items.length) {
          throw frontendError(
            `index ${idx} is out of range for a list of length ${items.length}`,
            "a list is read by its index, as in a[0]",
          );
        }
        return programValue(items[idx], bindings);
      }
      if (fieldOf(one, "base").k !== "name") {
        throw frontendError(
          `a program cannot read an element of ${describeValue(one.base)}`,
          "a list is read by its index, as in a[0]",
        );
      }
      return { k: "element", buffer: fieldOf(one, "base").name, index: programValue(fieldOf(one, "index"), bindings) };
    }
    case "slice": {
      // Resolve the base to the PyValue it holds (a name looks up its value).
      let base = one.base;
      if (base.k === "name" && hasValue(bindings, String(base.name))) {
        base = valueAt(bindings, String(base.name))!;
      }
      // A program can slice a list or a string whose contents are known: a
      // literal or a name bound to one. Anything else is refused.
      if (base.k === "text") {
        // Resolve the text to a plain string. A plain string (a single text
        // part) is used directly; an f-string is evaluated to a string when
        // every interpolated value is a constant.
        let text: string | null = null;
        const baseParts = fieldOf(base, "parts") as { k: string; value: string }[];
        if (baseParts.length === 1 && String(fieldOf(baseParts[0], "k")) === "text") {
          text = String(fieldOf(baseParts[0], "value"));
        } else {
          // Try to evaluate the f-string to a concrete string.
          const parts: string[] = [];
          let ok = true;
          for (const part of fieldOf(base, "parts")) {
            if (part.k === "text") {
              parts.push(part.value);
            } else {
              const str = stringOf(part.value, bindings);
              if (str === null) { ok = false; break; }
              parts.push(str);
            }
          }
          if (ok) text = parts.join("");
        }
        if (text === null) {
          throw frontendError(
            "a program can slice only a plain string or an f-string of constants",
            `slice ${describeValue(one.base)}, which is not a plain string`,
          );
        }
        const len = text.length;
        const sliceBound = (bound: PyValue | null, defaultValue: number): number => {
          if (bound === null) return defaultValue;
          let resolved = bound;
          if (resolved.k === "name" && hasValue(bindings, String(resolved.name))) {
            resolved = valueAt(bindings, String(resolved.name))!;
          }
          if (resolved.k === "unary" && resolved.op === "-") {
            const n = numberOf(fieldOf(resolved, "operand"));
            return Math.max(0, len - n);
          }
          return numberOf(resolved);
        };
        let step = 1;
        const stepRaw = fieldOf(one, "step") as PyValue | null;
        if (stepRaw !== null) {
          let resolved = stepRaw;
          if (resolved.k === "name" && hasValue(bindings, String(resolved.name))) {
            resolved = valueAt(bindings, String(resolved.name))!;
          }
          if (resolved.k === "unary" && resolved.op === "-") {
            step = -numberOf(fieldOf(resolved, "operand"));
          } else {
            step = numberOf(resolved);
          }
        }
        if (step === 0) {
          throw frontendError("a slice step must not be zero", "a slice step of zero is not allowed");
        }
        const start = sliceBound(one.start, step > 0 ? 0 : len - 1);
        const stop = sliceBound(one.stop, step > 0 ? len : -1);
        let sliced = "";
        if (step > 0) {
          for (let i = Math.max(0, Math.min(start, len)); i < Math.max(0, Math.min(stop, len)); i += step) {
            sliced += text[i];
          }
        } else {
          for (let i = Math.min(len - 1, Math.max(start, -1)); i > Math.max(-1, Math.min(stop, -1)); i += step) {
            sliced += text[i];
          }
        }
        return { k: "text", parts: [{ k: "text", value: sliced }] };
      }
      if (base.k !== "list") {
        throw frontendError(
          "a program can slice only a list or a string",
          `slice ${describeValue(one.base)}, which is not a list or a string`,
        );
      }
      const items = fieldOf(base, "items");
      const len = items.length;
      // A slice bound: null means the default, a number is taken as-is, a name
      // is looked up, and a negative unary counts from the end (`len - n`).
      const sliceBound = (bound: PyValue | null, defaultValue: number): number => {
        if (bound === null) return defaultValue;
        let resolved = bound;
        if (resolved.k === "name" && hasValue(bindings, String(resolved.name))) {
          resolved = valueAt(bindings, String(resolved.name))!;
        }
        if (resolved.k === "unary" && resolved.op === "-") {
          const n = numberOf(fieldOf(resolved, "operand"));
          return Math.max(0, len - n);
        }
        return numberOf(resolved);
      };
      // Step is taken as-is (it may be negative), not as `len - n`.
      let step = 1;
      const stepRaw = fieldOf(one, "step") as PyValue | null;
      if (stepRaw !== null) {
        let resolved = stepRaw;
        if (resolved.k === "name" && hasValue(bindings, String(resolved.name))) {
          resolved = valueAt(bindings, String(resolved.name))!;
        }
        if (resolved.k === "unary" && resolved.op === "-") {
          step = -numberOf(fieldOf(resolved, "operand"));
        } else {
          step = numberOf(resolved);
        }
      }
      if (step === 0) {
        throw frontendError("a slice step must not be zero", "a slice step of zero is not allowed");
      }
      const start = sliceBound(one.start, step > 0 ? 0 : len - 1);
      const stop = sliceBound(one.stop, step > 0 ? len : -1);
      const sliced: PyValue[] = [];
      if (step > 0) {
        for (let i = Math.max(0, Math.min(start, len)); i < Math.max(0, Math.min(stop, len)); i += step) {
          sliced.push(items[i]);
        }
      } else {
        for (let i = Math.min(len - 1, Math.max(start, -1)); i > Math.max(-1, Math.min(stop, -1)); i += step) {
          sliced.push(items[i]);
        }
      }
      const whole = sliced.every((item) => item.k === "number" && fieldOf(item, "whole"));
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: sliced.map((item) => programValue(item, bindings)) };
    }
    case "field": {
      // A dict has no fields: Python reads one by its key, and a field of it
      // is an attribute the language does not have.
      if (one.base.k === "name" && hasDict(bindings, String(fieldOf(one, "base").name))) {
        throw frontendError(
          "a dict is read by its key",
          `as in ${one.base.name}["${one.field}"], which is how Python reads a field of a dict`,
        );
      }
      return { k: "field", object: programValue(one.base, bindings), field: one.field };
    }
    case "membership": {
      let container = one.container;
      if (String(fieldOf(container, "k")) === "name" && hasValue(bindings, String(fieldOf(container, "name")))) container = valueAt(bindings, String(fieldOf(container, "name")))!;
      const items: PyValue[] = [];
      if (String(fieldOf(container, "k")) === "list" || String(fieldOf(container, "k")) === "set") {
        for (const item of fieldOf(container, "items") as PyValue[]) items[items.length] = item;
      }
      else {
        const oneContainer = fieldOf(one, "container") as PyValue;
        const containerArgs = fieldOf(oneContainer, "args") as PyValue[];
        if (String(fieldOf(oneContainer, "k")) === "call" && String(fieldOf(oneContainer, "name")) === "range" && containerArgs.length === 1 && String(fieldOf(containerArgs[0], "k")) === "number") {
          const n = Number(fieldOf(containerArgs[0], "text"));
          for (let i = 0; i < n; i++) items.push({ k: "number", text: String(i), whole: true });
        } else {
          throw frontendError("membership needs a list or a range with a constant bound", "write the list out");
        }
      }
      const set = new SparseSet();
      for (const item of items) set.add(item);
      const found = set.has(fieldOf(one, "value") as PyValue);
      return { k: "boolean", value: fieldOf(one, "negated") === true ? !found : found };
    }
    case "lambda": {
      // The parameters of a lambda are whole numbers unless a use says
      // otherwise: the arrow the program model holds names each parameter's
      // type, and a Python lambda writes none.
      return {
        k: "arrow",
        // The body a call reads is the lambda's own, which the program model
        // inlines where the call is written. The arrow registered here is the
        // function the name holds; its body is a placeholder, since a lambda
        // is only ever called.
        params: (fieldOf(one, "params") as readonly { readonly name: string }[]).map((param) => ({ name: String(fieldOf(param, "name")), type: "bigint" })),
        body: [{ kind: "result", value: { k: "whole", text: "0" }, line: 0 }],
      };
    }
    case "walrus": {
      // Should have been lifted by expandWalrus; evaluate the value as a
      // fallback.
      bound(bindings, String(fieldOf(one, "name")), fieldOf(one, "value") as PyValue);
      return programValue(fieldOf(one, "value") as PyValue, bindings);
    }
    case "comprehension": {
      const iterableItems: PyValue[] = [];
      const oneIterable = fieldOf(one, "iterable") as PyValue;
      const iterableArgs = fieldOf(oneIterable, "args") as PyValue[];
      if (String(fieldOf(oneIterable, "k")) === "list") {
        for (const item of fieldOf(oneIterable, "items") as PyValue[]) iterableItems[iterableItems.length] = item;
      } else if (String(fieldOf(oneIterable, "k")) === "call" && String(fieldOf(oneIterable, "name")) === "range" && iterableArgs.length === 1 && String(fieldOf(iterableArgs[0], "k")) === "number") {
        const n = Number(fieldOf(iterableArgs[0], "text"));
        for (let i = 0; i < n; i++) iterableItems.push({ k: "number", text: String(i), whole: true });
      } else {
        throw frontendError("a comprehension needs a list or a range with a constant bound", "write the list out, as in [f(x) for x in [1, 2, 3]]");
      }
      const values: ProgramValue[] = [];
      for (const item of iterableItems) {
        const child = cloneBindings(bindings);
        child.values.set(one.target, item);
        if (one.condition !== null) {
          const cond = programValue(one.condition, child);
          if (cond.k === "boolean" && !cond.value) continue;
        }
        values.push(programValue(one.element, child));
      }
      const names = new Map();
      const iterable = fieldOf(one, "iterable") as ProgramValue;
      const target = String(fieldOf(one, "target"));
      if (String(fieldOf(iterable, "k")) === "call" && String(fieldOf(iterable, "name")) === "range") names.set(target, "int");
      else if (String(fieldOf(iterable, "k")) === "list") {
        const items = fieldOf(iterable, "items") as ProgramValue[];
        if (items.length > 0 && String(fieldOf(items[0], "k")) === "number") names.set(target, fieldOf(items[0], "whole") === true ? "int" : "float");
      }
      const whole = typeOfValue(one.element, names) === "int";
      return { k: "buffer", element: whole ? "i64" : "f64", values };
    }
    case "list": {
      // A list written out is a buffer of the numbers it holds, and the width
      // of an element is what the list holds it at.
      const listItems = fieldOf(one, "items") as ProgramValue[];
      let whole = true;
      for (const item of listItems) {
        if (String(fieldOf(item, "k")) !== "number" || fieldOf(item, "whole") !== true) {
          whole = false;
          break;
        }
      }
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: one.items.map((item) => programValue(item, bindings)) };
    }
    case "set": {
      // Pick the representation by domain: a bitset for small bounded
      // non-negative integers, a sparse set otherwise.
      const nums = one.items.filter((i) => i.k === "number" && fieldOf(i, "whole")).map((i) => Number((i as { k: "number"; text: string }).text));
      const allNonNegInts = one.items.length > 0 && one.items.every((i) => i.k === "number" && fieldOf(i, "whole") && Number(i.text) >= 0);
      const max = allNonNegInts ? Math.max(...nums) : -1;
      let deduped: PyValue[];
      if (allNonNegInts && max <= 1024) {
        const bs = new BitSet(max + 1);
        deduped = [];
        for (const item of one.items) {
          const v = Number((item as { k: "number"; text: string }).text);
          if (!bs.has(v)) { bs.add(v); deduped.push(item); }
        }
      } else {
        const set = new SparseSet();
        for (const item of one.items) set.add(item);
        deduped = set.toArray();
      }
      const whole = deduped.every((item) => item.k === "number" && fieldOf(item, "whole"));
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: deduped.map((item) => programValue(item, bindings)) };
    }
    case "sized": {
      throw frontendError("a sized array is not part of a program", "write the list out, as in [1, 2, 3]");
    }
    case "dict":
      return { k: "object", fields: one.entries.map((entry) => ({ name: entry.name, value: programValue(entry.value, bindings) })) };
    case "binary": {
      // Resolve operands that are names bound to values.
      const resolve = (v: PyValue): PyValue => (v.k === "name" && hasValue(bindings, String(v.name))) ? valueAt(bindings, String(v.name))! : v;
      const left = resolve(fieldOf(one, "left"));
      const right = resolve(fieldOf(one, "right"));
      // List concatenation: a + b where both are lists produces a new list.
      if (String(fieldOf(one, "op")) === "+" && left.k === "list" && right.k === "list") {
        const items: PyValue[] = [];
        for (const item of fieldOf(left, "items") as PyValue[]) items[items.length] = item;
        for (const item of fieldOf(right, "items") as PyValue[]) items[items.length] = item;
        let whole = true;
        for (const item of items) {
          if (String(fieldOf(item, "k")) !== "number" || fieldOf(item, "whole") !== true) {
            whole = false;
            break;
          }
        }
        const element: PrimitiveTypeName = whole ? "i64" : "f64";
        const values: ProgramValue[] = [];
        for (const item of items) values[values.length] = programValue(item, bindings);
        return { k: "buffer", element, values };
      }
      // Set operations: union, intersection, difference, symmetric difference.
      if (left.k === "set" && right.k === "set") {
        const leftSet = new SparseSet();
        for (const item of fieldOf(left, "items")) leftSet.add(item);
        const rightSet = new SparseSet();
        for (const item of fieldOf(right, "items")) rightSet.add(item);

        if (one.op === "|") {
          const result = new SparseSet();
          for (const item of fieldOf(left, "items")) result.add(item);
          for (const item of fieldOf(right, "items")) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && fieldOf(i, "whole"));
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "&") {
          const result = new SparseSet();
          for (const item of fieldOf(left, "items")) if (rightSet.has(item)) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && fieldOf(i, "whole"));
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "-") {
          const result = new SparseSet();
          for (const item of fieldOf(left, "items")) if (!rightSet.has(item)) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && fieldOf(i, "whole"));
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "^") {
          const result = new SparseSet();
          for (const item of fieldOf(left, "items")) if (!rightSet.has(item)) result.add(item);
          for (const item of fieldOf(right, "items")) if (!leftSet.has(item)) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && fieldOf(i, "whole"));
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "<=") {
          const ok = allIn(itemsOf(left), rightSet);
          return { k: "boolean", value: ok };
        }
        if (one.op === "<") {
          const ok = allIn(itemsOf(left), rightSet) && itemsOf(left).length < itemsOf(right).length;
          return { k: "boolean", value: ok };
        }
        if (one.op === ">=") {
          const ok = allIn(itemsOf(right), leftSet);
          return { k: "boolean", value: ok };
        }
        if (one.op === ">") {
          const ok = allIn(itemsOf(right), leftSet) && itemsOf(right).length < itemsOf(left).length;
          return { k: "boolean", value: ok };
        }
        if (one.op === "==" || one.op === "!=") {
          const ok = itemsOf(left).length === itemsOf(right).length && allIn(itemsOf(left), rightSet);
          return { k: "boolean", value: String(fieldOf(one, "op")) === "==" ? ok : !ok };
        }
      }
      // String concatenation is handled by the binary operator.
      const operator = BINARY_OPERATORS[String(fieldOf(one, "op"))];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an operator a program has`,
          "the operators of a program are the arithmetic, the comparison and the logical ones",
        );
      }
      return { k: "binary", op: operator, left: programValue(fieldOf(one, "left"), bindings), right: programValue(fieldOf(one, "right"), bindings) };
    }
    case "unary": {
      const operator = UNARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an operator a program has`,
          "the operators of a program are the arithmetic, the comparison and the logical ones",
        );
      }
      return { k: "unary", op: operator, operand: programValue(fieldOf(one, "operand"), bindings) };
    }
    case "conditional":
      return {
        k: "conditional",
        condition: programValue(one.condition, bindings),
        then: programValue(fieldOf(one, "then"), bindings),
        otherwise: programValue(one.otherwise, bindings),
      };
  }
}

/** The string a PyValue holds at compile time, or null when it cannot be
 *  evaluated to a string. Handles numbers, booleans, None, plain strings,
 *  names bound to a string, and f-strings of constants. */
function stringOf(value: PyValue, bindings: Bindings): string | null {
  if (value.k === "number") return value.text;
  if (value.k === "boolean") return fieldOf(value, "value") ? "True" : "False";
  if (value.k === "none") return "None";
  if (value.k === "text") {
    const parts: string[] = [];
    for (const part of fieldOf(value, "parts")) {
      if (part.k === "text") {
        parts.push(part.value);
      } else {
        const str = stringOf(part.value, bindings);
        if (str === null) return null;
        parts.push(str);
      }
    }
    return parts.join("");
  }
  if (value.k === "name" && hasValue(bindings, String(value.name))) {
    return stringOf(valueAt(bindings, String(value.name))!, bindings);
  }
  return null;
}

/** The whole number a PyValue holds, refusing anything that is not one. */
function numberOf(value: PyValue): number {
  if (value.k !== "number") {
    throw frontendError(
      "a slice bound must be a number",
      `a slice bound is ${describeValue(value)}`,
    );
  }
  return Number(value.text);
}

/** The text of a value written as it is, or null when it is not one text. */
function textOf(value: PyValue): string | null {
  if (value.k !== "text") return null;
  if (fieldOf(value, "parts").length !== 1) return null;
  const part = fieldOf(value, "parts")[0];
  return part.k === "text" ? part.value : null;
}

/** The parts of a string, as the program model holds them. */
function text(parts: readonly PyTextPart[], bindings: Bindings): ProgramText[] {
  return parts.map((part) =>
    part.k === "text" ? { k: "text", value: part.value } : { k: "value", value: programValue(part.value, bindings) },
  );
}

/**
 * A Python statement, as the program model holds it.
 */
function statement(one: PyStatement, bindings: Bindings): ProgramStatement {
  switch (one.k) {
    case "declare": {
      const value = programValue(fieldOf(one, "value"), bindings);
      bound(bindings, String(fieldOf(one, "name")), fieldOf(one, "value"));
      return {
        kind: "declare",
        name: String(fieldOf(one, "name")),
        mutable: true,
        type: null,
        value,
        line: Number(fieldOf(one, "line")),
      };
    }
    case "assign": {
      const operator = ASSIGN_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an assignment a program can make`,
          "a program assigns a name a value, as in `x = 1`",
        );
      }
      const value = programValue(fieldOf(one, "value") as PyValue, bindings);
      // An assignment states a new value for the name, and whether that value
      // may be read out of the binding is a question about the name it writes:
      // a plain assignment binds the value the source wrote, and a compound one
      // does not, because `x += 1` is not `x = 1` and binding it to the right
      // side would answer a number the program never held. The block that holds
      // the write invalidates what it wrote when it ends, so a loop or a branch
      // cannot leave a value behind that only one turn or one arm computed.
      if (one.op === "=") bound(bindings, String(fieldOf(one, "name")), fieldOf(one, "value") as PyValue);
      else forget(bindings, String(fieldOf(one, "name")));
      return { kind: "assign", name: String(fieldOf(one, "name")), op: operator, value, line: Number(fieldOf(one, "line")) };
    }
    case "storeElement": {
      const target = fieldOf(one, "target") as { k: "index"; base: PyValue; index: PyValue };
      const base = fieldOf(target, "base") as PyValue;
      if (base.k !== "name") {
        throw frontendError('"a[i] = value" is not supported', "the object is a name the program holds");
      }
      return {
        kind: "elementAssign",
        buffer: String(fieldOf(base, "name")),
        index: programValue(fieldOf(target, "index") as PyValue, bindings),
        op: "=",
        value: programValue(fieldOf(one, "value") as PyValue, bindings),
        line: fieldOf(one, "line"),
      };
    }
    case "storeSlice": {
      const base = one.base;
      // If the RHS is a list literal, handle it.
      const storeValue = fieldOf(one, "value") as PyValue;
      if (storeValue.k === "list") {
        const rhsItems = fieldOf(storeValue, "items") as PyValue[];
        // Resolve base to its list value if known.
        const baseVal = valueAt(bindings, String(base));
        const baseItems = baseVal !== undefined && baseVal.k === "list" ? fieldOf(baseVal, "items") : [];
        const baseLen = baseItems.length;
        // Compute slice indices.
        let startBound = 0;
        if (one.start !== null) {
          if (one.start.k === "number") {
            startBound = Number(one.start.text);
          } else if (one.start.k === "unary" && one.start.op === "-") {
            const operand = fieldOf(one.start, "operand");
            const n = operand.k === "number" ? Number(fieldOf(operand, "text")) : 0;
            startBound = Math.max(0, baseLen - n);
          }
        }
        if (startBound < 0) startBound = 0;
        if (startBound > baseLen) startBound = baseLen;
        const stepValue = fieldOf(one, "step") as PyValue | null;
        const step = stepValue === null ? 1 : (String(fieldOf(stepValue, "k")) === "number" ? Number(fieldOf(stepValue, "text")) : 1);
        // Compute stop bound.
        let stopBound = baseLen;
        if (one.stop !== null) {
          if (one.stop.k === "number") {
            stopBound = Number(one.stop.text);
          } else if (one.stop.k === "unary" && one.stop.op === "-") {
            const operand = fieldOf(one.stop, "operand");
            const n = operand.k === "number" ? Number(fieldOf(operand, "text")) : 0;
            stopBound = Math.max(0, baseLen - n);
          }
        }
        if (stopBound < 0) stopBound = 0;
        if (stopBound > baseLen) stopBound = baseLen;
        // Number of elements being replaced.
        const sliceLen = step > 0
          ? Math.max(0, Math.ceil((stopBound - startBound) / step))
          : Math.max(0, Math.ceil((startBound - stopBound) / -step));
        // If same length, desugar to element assignments (in-place).
        if (sliceLen === rhsItems.length) {
          const assignments: ProgramStatement[] = [];
          for (let j = 0; j < rhsItems.length; j++) {
            const idx = startBound + j * step;
            assignments.push({
              kind: "elementAssign",
              buffer: base,
              index: { k: "whole", text: String(idx) },
              op: "=",
              value: programValue(rhsItems[j], bindings),
              line: Number(fieldOf(one, "line")),
            });
          }
          return { kind: "block", body: assignments, line: Number(fieldOf(one, "line")) };
        }
        // Different length: the compiler's lists are fixed buffers, so
        // changing the length is not supported.
        throw frontendError(
          "slice assignment that changes the length is not supported",
          "a list is a buffer, and a buffer is fixed: replace elements in place, as in a[1:3] = [10, 20]",
        );
      }
      // Variable RHS: generate a runtime loop.
      const loopVar = "_i";
      const rhsValue = fieldOf(one, "value") as PyValue;
      // Number of iterations
      const nPy: PyValue = { k: "call", name: "len", args: [rhsValue] };
      // Resolve negative start to a positive index at compile time if possible.
      let startPy: PyValue;
      if (one.start === null) {
        startPy = { k: "number", text: "0", whole: true };
      } else if (one.start.k === "unary" && one.start.op === "-") {
        const operand = fieldOf(one.start, "operand");
        const n = operand.k === "number" ? Number(fieldOf(operand, "text")) : 0;
        const baseVal = valueAt(bindings, String(base));
        let len = 0;
        if (baseVal !== undefined && baseVal.k === "list") len = fieldOf(baseVal, "items").length;
        startPy = { k: "number", text: String(Math.max(0, len - n)), whole: true };
      } else {
        startPy = one.start;
      }
      // Step expression
      const stepSource = fieldOf(one, "step") as PyValue | null;
      const stepPy: PyValue = stepSource === null ? { k: "number", text: "1", whole: true } : stepSource;
      // Loop body: base[start + _i * step] = rhs[_i]
      const loopBody: PyStatement[] = [
        {
          k: "storeElement",
          target: {
            k: "index",
            base: { k: "name", name: base },
            index: {
              k: "binary",
              op: "+",
              left: startPy,
              right: {
                k: "binary",
                op: "*",
                left: { k: "name", name: loopVar },
                right: stepPy,
              },
            },
          },
          value: {
            k: "index",
            base: rhsValue,
            index: { k: "name", name: loopVar },
          },
          line: Number(fieldOf(one, "line")),
        },
      ];
      const loopStmt: PyStatement = {
        k: "for",
        variable: loopVar,
        from: { k: "number", text: "0", whole: true },
        to: nPy,
        step: null,
        body: loopBody,
        line: Number(fieldOf(one, "line")),
      };
      return statement(loopStmt, bindings);
    }
    case "storeField": {
      const target = one.target as { k: "field"; base: PyValue; field: string };
      const base = target.base;
      if (base.k !== "name") {
        throw frontendError(
          '"obj.field = value" is not supported',
          "the object is a name the program holds",
        );
      }
      const value = programValue(fieldOf(one, "value") as PyValue, bindings);
      return {
        kind: "fieldAssign",
        object: String(fieldOf(base, "name")),
        op: "=",
        field: target.field,
        value,
        line: Number(fieldOf(one, "line")),
      };
    }
    case "return":
      return { kind: "result", value: programValue(fieldOf(one, "value") as PyValue ?? { k: "none" }, bindings), line: Number(fieldOf(one, "line")) };
    case "if": {
      conditionIsBoolean(fieldOf(one, "condition"), fieldOf(one, "line"));
      const condition = programValue(fieldOf(one, "condition"), bindings);
      // The two arms are lowered against the names the `if` was written with,
      // and neither sees what the other wrote: only one of them runs.
      const thenScope = cloneBindings(bindings);
      const otherwiseScope = cloneBindings(bindings);
      const then = one.then.map((inside) => statement(inside, thenScope));
      const otherwise = one.otherwise.map((inside) => statement(inside, otherwiseScope));
      invalidate(bindings, thenScope);
      invalidate(bindings, otherwiseScope);
      return { kind: "if", condition, then, otherwise, line: fieldOf(one, "line") };
    }
    case "while": {
      conditionIsBoolean(fieldOf(one, "condition"), fieldOf(one, "line"));
      const condition = programValue(fieldOf(one, "condition"), bindings);
      return { kind: "while", condition, body: branch(fieldOf(one, "body") as PyStatement[], bindings), line: Number(fieldOf(one, "line")) };
    }
    case "for":
      return {
        kind: "for",
        variable: String(fieldOf(one, "variable")),
        from: programValue(fieldOf(one, "from") as PyValue, bindings),
        to: programValue(fieldOf(one, "to") as PyValue, bindings),
        inclusive: false,
        down: false,
        type: null,
        step: fieldOf(one, "step") === null ? null : programValue(fieldOf(one, "step") as PyValue, bindings),
        body: branch(fieldOf(one, "body") as PyStatement[], bindings),
        line: Number(fieldOf(one, "line")),
      };
    case "break":
      return { kind: "break", line: Number(fieldOf(one, "line")) };
    case "continue":
      return { kind: "continue", line: Number(fieldOf(one, "line")) };
    case "pass":
      return { kind: "block", body: [], line: Number(fieldOf(one, "line")) };
    case "print":
      const printValues: ProgramValue[] = [];
      for (const value of fieldOf(one, "values") as PyValue[]) printValues[printValues.length] = programValue(value, bindings);
      return { kind: "print", values: printValues, line: Number(fieldOf(one, "line")) };
    case "try": {
      // A compiled program cannot raise, so there is nothing to catch: the
      // body runs and the block that catches is not read. The block that runs
      // whatever happens does run, and it runs after the body.
      const combined: PyStatement[] = [];
      for (const statement of fieldOf(one, "body") as PyStatement[]) combined[combined.length] = statement;
      const finallyBody = fieldOf(one, "finallyBody") as PyStatement[] | null;
      if (finallyBody !== null) for (const statement of finallyBody) combined[combined.length] = statement;
      const body = branch(combined, bindings);
      return { kind: "block", body, line: Number(fieldOf(one, "line")) };
    }
    case "call": {
      const called = fieldOf(one, "value");
      if (called.k !== "call") {
        throw frontendError(`"${describeValue(called)}" is not a call`, "a statement of a program is a call");
      }
      if (fieldOf(called, "grid") !== undefined) {
        const invokeArgs: ProgramValue[] = [];
        for (const argument of fieldOf(called, "args") as readonly PyValue[]) invokeArgs[invokeArgs.length] = programValue(argument, bindings);
        return {
          kind: "invoke",
          function: builtinName(String(fieldOf(called, "name"))),
          args: invokeArgs,
          grid: fieldOf(called, "grid"),
          line: Number(fieldOf(one, "line")),
        } as any;
      }
      return {
        kind: "invoke",
        function: builtinName(called.name),
        args: (fieldOf(called, "args") as readonly PyValue[]).map((argument) => programValue(argument, bindings)),
        line: Number(fieldOf(one, "line")),
      };
    }
    case "function":
      throw frontendError(
        "a function of a program is declared at the top of the module",
        "a function is declared at the top of the file it is written in",
      );
  }
}

/**
 * What a name holds, as far as the body says: a dict is an object, and the
 * keys it holds are what a read of it by a key is checked against.
 */
function bound(bindings: Bindings, name: string, value: PyValue): void {
  if (value.k === "dict") {
    setDict(bindings, name, new Set(value.entries.map((entry) => entry.name)));
  } else {
    deleteDict(bindings, name);
  }
  setValue(bindings, name, value);
}

/** A name whose value the body no longer knows: it is read as the name it is. */
function forget(bindings: Bindings, name: string): void {
  deleteValue(bindings, name);
  deleteDict(bindings, name);
}

/**
 * What a block did to the names around it.
 *
 * A block may run no times, once, or many times, and what it wrote is not the
 * value the name holds when the block ends: a loop's every turn writes the
 * same names, and an arm of a branch writes the names only that arm writes.
 * The block is lowered against a copy of the bindings, and every name the copy
 * answers differently is forgotten by the block that holds it, so what the
 * program reads after a loop or a branch is the name, not the last value a
 * turn happened to compute.
 */
function invalidate(bindings: Bindings, after: Bindings): void {
  const seen: Set<string> = new Set();
  for (const name of valueNames(bindings)) seen.add(name);
  for (const name of valueNames(after)) seen.add(name);
  for (const name of seen) {
    if (valueAt(bindings, name) !== valueAt(after, name)) forget(bindings, name);
  }
  const dictNames: Set<string> = new Set();
  for (const name of dictsOf(bindings).keys()) dictNames.add(name);
  for (const name of dictsOf(after).keys()) dictNames.add(name);
  for (const name of dictNames) {
    if (dictOf(bindings, name) !== dictOf(after, name)) forget(bindings, name);
  }
}

/** The statements of a block, lowered against a copy of the names around it. */
function branch(body: readonly PyStatement[], bindings: Bindings): ProgramStatement[] {
  const scoped = cloneBindings(bindings);
  const lowered = body.map((inside) => statement(inside, scoped));
  invalidate(bindings, scoped);
  return lowered;
}

/** Whether a value is the command line of a Python program. */
function isSysArgv(value: PyValue): boolean {
  return value.k === "field" && value.field === "argv" && value.base.k === "name" && value.base.name === "sys";
}

/**
 * The statements of a Python module that run, as the program model holds them.
 */
export function lowerProgramBody(body: readonly PyStatement[]): ProgramStatement[] {
  const bindings = noBindings();
  return body.map((one) => statement(one, bindings));
}

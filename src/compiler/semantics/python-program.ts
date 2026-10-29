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
  return { dicts: new Map(b.dicts), values: new Map(b.values) };
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
    return index < this.dense.length && this.keyOf(this.dense[index]) === key;
  }

  add(value: PyValue): boolean {
    if (this.has(value)) return false;
    this.sparse.set(this.keyOf(value), this.dense.length);
    this.dense.push(value);
    return true;
  }

  remove(value: PyValue): boolean {
    const key = this.keyOf(value);
    const index = this.sparse.get(key);
    if (index === undefined || index >= this.dense.length || this.keyOf(this.dense[index]) !== key) return false;
    const last = this.dense[this.dense.length - 1];
    this.dense[index] = last;
    this.sparse.set(this.keyOf(last), index);
    this.dense.pop();
    this.sparse.delete(key);
    return true;
  }

  toArray(): PyValue[] {
    return [...this.dense];
  }

  get size(): number {
    return this.dense.length;
  }

  clear(): void {
    this.dense = [];
    this.sparse.clear();
  }
}

function programValue(one: PyValue, bindings: Bindings): ProgramValue {
  if (one.k === "name" && bindings.values.has(one.name)) {
    return programValue(bindings.values.get(one.name)!, bindings);
  }
  switch (one.k) {
    case "number":
      return one.whole ? { k: "whole", text: one.text } : { k: "number", text: one.text };
    case "text":
      return { k: "text", parts: text(one.parts, bindings) };
    case "boolean":
      return { k: "boolean", value: one.value };
    case "none":
      return { k: "null" };
    case "name":
      return { k: "name", name: one.name };
    case "await":
      // `await v` is the value the promise `v` carries, which the program body
      // reads where it is written.
      return { k: "call", function: "Promise.await", args: [programValue(one.value, bindings)] };
    case "call": {
      // A name bound to a function (a lambda) is called by inlining its body
      // with the arguments bound to its parameters.
      if (one.name !== "len" && one.name !== "str" && one.name !== "tl.where" && bindings.values.has(one.name)) {
        const fn = bindings.values.get(one.name)!;
        if (fn.k === "lambda") {
          const child = cloneBindings(bindings);
          fn.params.forEach((param, idx) => {
            if (idx < one.args.length) child.values.set(param.name, one.args[idx]);
          });
          // Inline: evaluate the body (single expression).
          return programValue(fn.body, child);
        }
      }
      // `len(x)` is the length of the list or of the text `x` holds, and the
      // program model reads a length off the name it is written by.
      if (one.name === "len" && one.args.length === 1 && one.args[0].k === "name") {
        return { k: "length", of: one.args[0].name };
      }
      // The length of the command line is the length of the list of texts
      // Python holds, which is the file the program runs and the arguments it
      // was given.
      if (one.name === "len" && one.args.length === 1 && isSysArgv(one.args[0])) {
        return { k: "call", function: "argvLength", args: [] };
      }
      // The length of a text written out is the length of a name: the program
      // model reads a length off the name it is written by, and a text written
      // out is not one.
      if (one.name === "len" && one.args.length === 1) {
        throw frontendError(
          "the length of a value written out is not read",
          "write the value into a name and take the length of that, as in `s = 'hello'` and then `len(s)`",
        );
      }
      // `str(x)` is the text of the value, which the runtime writes.
      if (one.name === "str" && one.args.length === 1) {
        return { k: "text", parts: [{ k: "value", value: programValue(one.args[0], bindings) }] };
      }
      // `tl.where(c, x, y)` is the choice the program model writes, whether the
      // source spelled it `x if c else y` or `tl.where`.
      if (one.name === "tl.where" && one.args.length === 3) {
        return {
          k: "conditional",
          condition: programValue(one.args[0], bindings),
          then: programValue(one.args[1], bindings),
          otherwise: programValue(one.args[2], bindings),
        };
      }
      if ((one as any).grid !== undefined) {
        return { k: "call", function: builtinName(one.name), args: one.args.map((argument) => programValue(argument, bindings)), grid: programValue((one as any).grid, bindings) } as any;
      }
      return { k: "call", function: builtinName(one.name), args: one.args.map((argument) => programValue(argument, bindings)) };
    }
    case "index": {
      // `sys.argv[i]` is the command line of the program: the compiler counts
      // the program and the file it runs before the arguments, and Python
      // counts the file alone, so the argument a Python program reads at `i`
      // is the one the compiler holds at `i + 1`.
      if (isSysArgv(one.base)) {
        return { k: "argv", index: programValue(one.index, bindings), offset: 1 };
      }
      // A dict is an object, and its fields are read by their key: `d["key"]`
      // is a field of the object the name holds, and not an element of a
      // buffer of numbers.
      if (one.base.k === "name" && one.index.k === "text") {
        const keys = bindings.dicts.get(one.base.name);
        if (keys !== undefined) {
          const key = textOf(one.index);
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
          return { k: "field", object: { k: "name", name: one.base.name }, field: key };
        }
      }
      // A slice produces a buffer, and indexing into it is resolved at compile
      // time when the slice and the index are both constant.
      if (one.base.k === "slice") {
        const sliced = programValue(one.base, bindings);
        if (sliced.k !== "buffer") {
          throw frontendError(
            `a program cannot read an element of ${describeValue(one.base)}`,
            "a list is read by its index, as in a[0]",
          );
        }
        let idx: number;
        if (one.index.k === "number") {
          idx = Number(one.index.text);
        } else if (one.index.k === "unary" && one.index.op === "-") {
          const n = one.index.operand.k === "number" ? Number(one.index.operand.text) : 0;
          idx = sliced.values.length - n;
        } else if (
          one.index.k === "binary" && one.index.op === "-" &&
          one.index.left.k === "call" && one.index.left.name === "len" &&
          one.index.left.args.length === 1 && one.index.left.args[0].k === "slice"
        ) {
          // The parser converted a[-n] to a[len(a)-n]; resolve it using
          // the slice's known length.
          const n = one.index.right.k === "number" ? Number(one.index.right.text) : 0;
          idx = sliced.values.length - n;
        } else {
          // Try evaluating the index.
          const indexValue = programValue(one.index, bindings);
          if (indexValue.k === "whole" || indexValue.k === "number") {
            idx = Number(indexValue.text);
          } else {
            throw frontendError(
              `a program cannot read an element of ${describeValue(one.base)} with a non-constant index`,
              "a list is read by its index, as in a[0]",
            );
          }
        }
        if (idx < 0 || idx >= sliced.values.length) {
          throw frontendError(
            `index ${idx} is out of range for a slice of length ${sliced.values.length}`,
            "a list is read by its index, as in a[0]",
          );
        }
        return sliced.values[idx];
      }
      // A list literal is indexed directly.
      if (one.base.k === "list") {
        const items = one.base.items;
        const indexValue = programValue(one.index, bindings);
        let idx: number;
        if (indexValue.k === "whole" || indexValue.k === "number") {
          idx = Number(indexValue.text);
        } else if (one.index.k === "unary" && one.index.op === "-") {
          const n = one.index.operand.k === "number" ? Number(one.index.operand.text) : 0;
          idx = items.length - n;
        } else {
          throw frontendError(
            `a program cannot read an element of a list with a non-constant index`,
            "a list is read by its index, as in a[0]",
          );
        }
        if (idx < 0 || idx >= items.length) {
          throw frontendError(
            `index ${idx} is out of range for a list of length ${items.length}`,
            "a list is read by its index, as in a[0]",
          );
        }
        return programValue(items[idx], bindings);
      }
      if (one.base.k !== "name") {
        throw frontendError(
          `a program cannot read an element of ${describeValue(one.base)}`,
          "a list is read by its index, as in a[0]",
        );
      }
      return { k: "element", buffer: one.base.name, index: programValue(one.index, bindings) };
    }
    case "slice": {
      // Resolve the base to the PyValue it holds (a name looks up its value).
      let base = one.base;
      if (base.k === "name" && bindings.values.has(base.name)) {
        base = bindings.values.get(base.name)!;
      }
      // A program can slice a list or a string whose contents are known: a
      // literal or a name bound to one. Anything else is refused.
      if (base.k === "text") {
        // Resolve the text to a plain string. A plain string (a single text
        // part) is used directly; an f-string is evaluated to a string when
        // every interpolated value is a constant.
        let text: string | null = null;
        if (base.parts.length === 1 && base.parts[0].k === "text") {
          text = base.parts[0].value;
        } else {
          // Try to evaluate the f-string to a concrete string.
          const parts: string[] = [];
          let ok = true;
          for (const part of base.parts) {
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
          if (resolved.k === "name" && bindings.values.has(resolved.name)) {
            resolved = bindings.values.get(resolved.name)!;
          }
          if (resolved.k === "unary" && resolved.op === "-") {
            const n = numberOf(resolved.operand);
            return Math.max(0, len - n);
          }
          return numberOf(resolved);
        };
        let step = 1;
        if (one.step !== null) {
          let resolved = one.step;
          if (resolved.k === "name" && bindings.values.has(resolved.name)) {
            resolved = bindings.values.get(resolved.name)!;
          }
          if (resolved.k === "unary" && resolved.op === "-") {
            step = -numberOf(resolved.operand);
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
      const items = base.items;
      const len = items.length;
      // A slice bound: null means the default, a number is taken as-is, a name
      // is looked up, and a negative unary counts from the end (`len - n`).
      const sliceBound = (bound: PyValue | null, defaultValue: number): number => {
        if (bound === null) return defaultValue;
        let resolved = bound;
        if (resolved.k === "name" && bindings.values.has(resolved.name)) {
          resolved = bindings.values.get(resolved.name)!;
        }
        if (resolved.k === "unary" && resolved.op === "-") {
          const n = numberOf(resolved.operand);
          return Math.max(0, len - n);
        }
        return numberOf(resolved);
      };
      // Step is taken as-is (it may be negative), not as `len - n`.
      let step = 1;
      if (one.step !== null) {
        let resolved = one.step;
        if (resolved.k === "name" && bindings.values.has(resolved.name)) {
          resolved = bindings.values.get(resolved.name)!;
        }
        if (resolved.k === "unary" && resolved.op === "-") {
          step = -numberOf(resolved.operand);
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
      const whole = sliced.every((item) => item.k === "number" && item.whole);
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: sliced.map((item) => programValue(item, bindings)) };
    }
    case "field": {
      // A dict has no fields: Python reads one by its key, and a field of it
      // is an attribute the language does not have.
      if (one.base.k === "name" && bindings.dicts.has(one.base.name)) {
        throw frontendError(
          "a dict is read by its key",
          `as in ${one.base.name}["${one.field}"], which is how Python reads a field of a dict`,
        );
      }
      return { k: "field", object: programValue(one.base, bindings), field: one.field };
    }
    case "membership": {
      let container = one.container;
      if (container.k === "name" && bindings.values.has(container.name)) container = bindings.values.get(container.name)!;
      const items: PyValue[] = [];
      if (container.k === "list" || container.k === "set") items.push(...container.items);
      else if (one.container.k === "call" && one.container.name === "range" && one.container.args.length === 1 && one.container.args[0].k === "number") {
        const n = Number(one.container.args[0].text);
        for (let i = 0; i < n; i++) items.push({ k: "number", text: String(i), whole: true });
      } else {
        throw frontendError("membership needs a list or a range with a constant bound", "write the list out");
      }
      const set = new SparseSet();
      for (const item of items) set.add(item);
      const found = set.has(one.value);
      return { k: "boolean", value: one.negated ? !found : found };
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
        params: one.params.map((param) => ({ name: param.name, type: "bigint" })),
        body: [{ kind: "result", value: { k: "whole", text: "0" }, line: 0 }],
      };
    }
    case "walrus": {
      // Should have been lifted by expandWalrus; evaluate the value as a
      // fallback.
      bound(bindings, one.name, one.value);
      return programValue(one.value, bindings);
    }
    case "comprehension": {
      const iterableItems: PyValue[] = [];
      if (one.iterable.k === "list") {
        iterableItems.push(...one.iterable.items);
      } else if (one.iterable.k === "call" && one.iterable.name === "range" && one.iterable.args.length === 1 && one.iterable.args[0].k === "number") {
        const n = Number(one.iterable.args[0].text);
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
      if (one.iterable.k === "call" && one.iterable.name === "range") names.set(one.target, "int");
      else if (one.iterable.k === "list" && one.iterable.items.length > 0 && one.iterable.items[0].k === "number") names.set(one.target, one.iterable.items[0].whole ? "int" : "float");
      const whole = typeOfValue(one.element, names) === "int";
      return { k: "buffer", element: whole ? "i64" : "f64", values };
    }
    case "list": {
      // A list written out is a buffer of the numbers it holds, and the width
      // of an element is what the list holds it at.
      const whole = one.items.every((item) => item.k === "number" && item.whole);
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: one.items.map((item) => programValue(item, bindings)) };
    }
    case "set": {
      // Pick the representation by domain: a bitset for small bounded
      // non-negative integers, a sparse set otherwise.
      const nums = one.items.filter((i) => i.k === "number" && i.whole).map((i) => Number((i as { k: "number"; text: string }).text));
      const allNonNegInts = one.items.length > 0 && one.items.every((i) => i.k === "number" && i.whole && Number(i.text) >= 0);
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
      const whole = deduped.every((item) => item.k === "number" && item.whole);
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
      const resolve = (v: PyValue): PyValue => (v.k === "name" && bindings.values.has(v.name)) ? bindings.values.get(v.name)! : v;
      const left = resolve(one.left);
      const right = resolve(one.right);
      // List concatenation: a + b where both are lists produces a new list.
      if (one.op === "+" && left.k === "list" && right.k === "list") {
        const items = [...left.items, ...right.items];
        const whole = items.every((item) => item.k === "number" && item.whole);
        const element: PrimitiveTypeName = whole ? "i64" : "f64";
        return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
      }
      // Set operations: union, intersection, difference, symmetric difference.
      if (left.k === "set" && right.k === "set") {
        const leftSet = new SparseSet();
        for (const item of left.items) leftSet.add(item);
        const rightSet = new SparseSet();
        for (const item of right.items) rightSet.add(item);

        if (one.op === "|") {
          const result = new SparseSet();
          for (const item of left.items) result.add(item);
          for (const item of right.items) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && i.whole);
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "&") {
          const result = new SparseSet();
          for (const item of left.items) if (rightSet.has(item)) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && i.whole);
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "-") {
          const result = new SparseSet();
          for (const item of left.items) if (!rightSet.has(item)) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && i.whole);
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "^") {
          const result = new SparseSet();
          for (const item of left.items) if (!rightSet.has(item)) result.add(item);
          for (const item of right.items) if (!leftSet.has(item)) result.add(item);
          const items = result.toArray();
          const whole = items.every((i) => i.k === "number" && i.whole);
          const element: PrimitiveTypeName = whole ? "i64" : "f64";
          return { k: "buffer", element, values: items.map((item) => programValue(item, bindings)) };
        }
        if (one.op === "<=") {
          const ok = left.items.every((x) => rightSet.has(x));
          return { k: "boolean", value: ok };
        }
        if (one.op === "<") {
          const ok = left.items.every((x) => rightSet.has(x)) && left.items.length < right.items.length;
          return { k: "boolean", value: ok };
        }
        if (one.op === ">=") {
          const ok = right.items.every((x) => leftSet.has(x));
          return { k: "boolean", value: ok };
        }
        if (one.op === ">") {
          const ok = right.items.every((x) => leftSet.has(x)) && right.items.length < left.items.length;
          return { k: "boolean", value: ok };
        }
        if (one.op === "==" || one.op === "!=") {
          const ok = left.items.length === right.items.length && left.items.every((x) => rightSet.has(x));
          return { k: "boolean", value: one.op === "==" ? ok : !ok };
        }
      }
      // String concatenation is handled by the binary operator.
      const operator = BINARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an operator a program has`,
          "the operators of a program are the arithmetic, the comparison and the logical ones",
        );
      }
      return { k: "binary", op: operator, left: programValue(one.left, bindings), right: programValue(one.right, bindings) };
    }
    case "unary": {
      const operator = UNARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an operator a program has`,
          "the operators of a program are the arithmetic, the comparison and the logical ones",
        );
      }
      return { k: "unary", op: operator, operand: programValue(one.operand, bindings) };
    }
    case "conditional":
      return {
        k: "conditional",
        condition: programValue(one.condition, bindings),
        then: programValue(one.then, bindings),
        otherwise: programValue(one.otherwise, bindings),
      };
  }
}

/** The string a PyValue holds at compile time, or null when it cannot be
 *  evaluated to a string. Handles numbers, booleans, None, plain strings,
 *  names bound to a string, and f-strings of constants. */
function stringOf(value: PyValue, bindings: Bindings): string | null {
  if (value.k === "number") return value.text;
  if (value.k === "boolean") return value.value ? "True" : "False";
  if (value.k === "none") return "None";
  if (value.k === "text") {
    const parts: string[] = [];
    for (const part of value.parts) {
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
  if (value.k === "name" && bindings.values.has(value.name)) {
    return stringOf(bindings.values.get(value.name)!, bindings);
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
  if (value.parts.length !== 1) return null;
  const part = value.parts[0];
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
      const value = programValue(one.value, bindings);
      bound(bindings, one.name, one.value);
      return {
        kind: "declare",
        name: one.name,
        mutable: true,
        type: null,
        value,
        line: one.line,
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
      const value = programValue(one.value, bindings);
      // An assignment states a new value for the name, and whether that value
      // may be read out of the binding is a question about the name it writes:
      // a plain assignment binds the value the source wrote, and a compound one
      // does not, because `x += 1` is not `x = 1` and binding it to the right
      // side would answer a number the program never held. The block that holds
      // the write invalidates what it wrote when it ends, so a loop or a branch
      // cannot leave a value behind that only one turn or one arm computed.
      if (one.op === "=") bound(bindings, one.name, one.value);
      else forget(bindings, one.name);
      return { kind: "assign", name: one.name, op: operator, value, line: one.line };
    }
    case "storeElement": {
      const target = one.target as { k: "index"; base: PyValue; index: PyValue };
      const base = target.base;
      if (base.k !== "name") {
        throw frontendError('"a[i] = value" is not supported', "the object is a name the program holds");
      }
      return {
        kind: "elementAssign",
        buffer: base.name,
        index: programValue(target.index, bindings),
        op: "=",
        value: programValue(one.value, bindings),
        line: one.line,
      };
    }
    case "storeSlice": {
      const base = one.base;
      // If the RHS is a list literal, handle it.
      if (one.value.k === "list") {
        const rhsItems = one.value.items;
        // Resolve base to its list value if known.
        const baseVal = bindings.values.get(base);
        const baseItems = baseVal !== undefined && baseVal.k === "list" ? baseVal.items : [];
        const baseLen = baseItems.length;
        // Compute slice indices.
        let startBound = 0;
        if (one.start !== null) {
          if (one.start.k === "number") {
            startBound = Number(one.start.text);
          } else if (one.start.k === "unary" && one.start.op === "-") {
            const n = one.start.operand.k === "number" ? Number(one.start.operand.text) : 0;
            startBound = Math.max(0, baseLen - n);
          }
        }
        if (startBound < 0) startBound = 0;
        if (startBound > baseLen) startBound = baseLen;
        const step = one.step === null ? 1 : (one.step.k === "number" ? Number(one.step.text) : 1);
        // Compute stop bound.
        let stopBound = baseLen;
        if (one.stop !== null) {
          if (one.stop.k === "number") {
            stopBound = Number(one.stop.text);
          } else if (one.stop.k === "unary" && one.stop.op === "-") {
            const n = one.stop.operand.k === "number" ? Number(one.stop.operand.text) : 0;
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
              line: one.line,
            });
          }
          return { kind: "block", body: assignments, line: one.line };
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
      const rhsValue = one.value;
      // Number of iterations
      const nPy: PyValue = { k: "call", name: "len", args: [rhsValue] };
      // Resolve negative start to a positive index at compile time if possible.
      let startPy: PyValue;
      if (one.start === null) {
        startPy = { k: "number", text: "0", whole: true };
      } else if (one.start.k === "unary" && one.start.op === "-") {
        const n = one.start.operand.k === "number" ? Number(one.start.operand.text) : 0;
        const baseVal = bindings.values.get(base);
        let len = 0;
        if (baseVal !== undefined && baseVal.k === "list") len = baseVal.items.length;
        startPy = { k: "number", text: String(Math.max(0, len - n)), whole: true };
      } else {
        startPy = one.start;
      }
      // Step expression
      const stepPy: PyValue = one.step === null ? { k: "number", text: "1", whole: true } : one.step;
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
          line: one.line,
        },
      ];
      const loopStmt: PyStatement = {
        k: "for",
        variable: loopVar,
        from: { k: "number", text: "0", whole: true },
        to: nPy,
        step: null,
        body: loopBody,
        line: one.line,
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
      const value = programValue(one.value, bindings);
      return {
        kind: "fieldAssign",
        object: base.name,
        op: "=",
        field: target.field,
        value,
        line: one.line,
      };
    }
    case "return":
      return { kind: "result", value: programValue(one.value ?? { k: "none" }, bindings), line: one.line };
    case "if": {
      conditionIsBoolean(one.condition, one.line);
      const condition = programValue(one.condition, bindings);
      // The two arms are lowered against the names the `if` was written with,
      // and neither sees what the other wrote: only one of them runs.
      const thenScope = cloneBindings(bindings);
      const otherwiseScope = cloneBindings(bindings);
      const then = one.then.map((inside) => statement(inside, thenScope));
      const otherwise = one.otherwise.map((inside) => statement(inside, otherwiseScope));
      invalidate(bindings, thenScope);
      invalidate(bindings, otherwiseScope);
      return { kind: "if", condition, then, otherwise, line: one.line };
    }
    case "while": {
      conditionIsBoolean(one.condition, one.line);
      const condition = programValue(one.condition, bindings);
      return { kind: "while", condition, body: branch(one.body, bindings), line: one.line };
    }
    case "for":
      return {
        kind: "for",
        variable: one.variable,
        from: programValue(one.from, bindings),
        to: programValue(one.to, bindings),
        inclusive: false,
        down: false,
        type: null,
        step: one.step === null ? null : programValue(one.step, bindings),
        body: branch(one.body, bindings),
        line: one.line,
      };
    case "break":
      return { kind: "break", line: one.line };
    case "continue":
      return { kind: "continue", line: one.line };
    case "pass":
      return { kind: "block", body: [], line: one.line };
    case "print":
      return { kind: "print", values: one.values.map((value) => programValue(value, bindings)), line: one.line };
    case "try": {
      // A compiled program cannot raise, so there is nothing to catch: the
      // body runs and the block that catches is not read. The block that runs
      // whatever happens does run, and it runs after the body.
      const body = branch([...one.body, ...(one.finallyBody ?? [])], bindings);
      return { kind: "block", body, line: one.line };
    }
    case "call": {
      const called = one.value;
      if (called.k !== "call") {
        throw frontendError(`"${describeValue(called)}" is not a call`, "a statement of a program is a call");
      }
      if ((called as any).grid !== undefined) {
        return {
          kind: "invoke",
          function: builtinName(called.name),
          args: called.args.map((argument) => programValue(argument, bindings)),
          grid: (called as any).grid,
          line: one.line,
        } as any;
      }
      return {
        kind: "invoke",
        function: builtinName(called.name),
        args: called.args.map((argument) => programValue(argument, bindings)),
        line: one.line,
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
    bindings.dicts.set(name, new Set(value.entries.map((entry) => entry.name)));
  } else {
    bindings.dicts.delete(name);
  }
  bindings.values.set(name, value);
}

/** A name whose value the body no longer knows: it is read as the name it is. */
function forget(bindings: Bindings, name: string): void {
  bindings.values.delete(name);
  bindings.dicts.delete(name);
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
  for (const name of new Set([...bindings.values.keys(), ...after.values.keys()])) {
    if (bindings.values.get(name) !== after.values.get(name)) forget(bindings, name);
  }
  for (const name of new Set([...bindings.dicts.keys(), ...after.dicts.keys()])) {
    if (bindings.dicts.get(name) !== after.dicts.get(name)) forget(bindings, name);
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

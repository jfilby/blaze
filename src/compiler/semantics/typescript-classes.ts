/**
 * TypeScript classes, read as the functions and objects they lower to.
 *
 * A class is a source-level construct the rest of the compiler does not need to
 * know: its constructor becomes a function that returns an object literal, each
 * method becomes a function whose first parameter is the instance it is called
 * on, and each static member becomes a function of the class. This pass reads
 * the classes of a file once, so the module parser and the program parser can
 * lower the declarations and every use of them against the same table.
 *
 * The scan is deliberately tolerant. A construct inside a class that is outside
 * the subset is recorded as a problem and the class is still described as far as
 * it can be, because a build names every construct it cannot read rather than
 * stopping at the first one. The parsers report the problems at the line the
 * source wrote them on.
 */

import type { Token } from "./typescript.ts";

/** One parameter of a method or constructor, as the source declared it. */
export interface ClassParam {
  name: string;
  /** The annotation as written, or `"any"` where the source wrote none. */
  typeName: string;
  /** `public x: number` in a constructor declares a field as well. */
  property: boolean;
  /** The tokens of a default value, or -1 when the parameter has none. */
  defaultStart: number;
  defaultEnd: number;
  line: number;
}

/** One field a class declares, and the value it starts at. */
export interface ClassField {
  name: string;
  typeName: string;
  /** The tokens of the initialiser, or -1 when it has none. */
  initStart: number;
  initEnd: number;
  line: number;
}

/** One method a class declares, or its constructor. */
export interface ClassMethod {
  name: string;
  params: ClassParam[];
  returnTypeName: string;
  /** The `{` that opens the body, and the token after the `}` that closes it. */
  bodyStart: number;
  bodyEnd: number;
  line: number;
}

export interface ClassInfo {
  name: string;
  base: string | null;
  fields: ClassField[];
  statics: ClassField[];
  constructor: ClassMethod | null;
  methods: ClassMethod[];
  staticMethods: ClassMethod[];
  /** The line the class was declared on. */
  line: number;
  /** First token of the declaration, including an `export` before it. */
  start: number;
  /** The token after the declaration's closing `}`. */
  end: number;
  exported: boolean;
  /** `export default class C`: the module's default export names the class. */
  isDefault: boolean;
}

export interface ClassTable {
  names: Set<string>;
  classes: Map<string, ClassInfo>;
  /** The order the source declared the classes in. */
  ordered: ClassInfo[];
  /** The class a module offers as its default export, if it has one. */
  defaultName: string | null;
  /** Constructs inside a class the lowering cannot read, with their lines. */
  problems: { message: string; detail: string; line: number }[];
}

const MEMBER_MODIFIERS: ReadonlySet<string> = new Set([
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "abstract",
  "declare",
  "override",
  "accessor",
]);

const PARAM_MODIFIERS: ReadonlySet<string> = new Set(["public", "private", "protected", "readonly"]);

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === "punct" && token.text === text;
}

/** The token after the `}` that closes the bracket opened at `open`. */
function matching(tokens: readonly Token[], open: number): number {
  const opener = tokens[open]?.text;
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : opener === "[" ? "]" : "";
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "punct") continue;
    if (token.text === opener) depth += 1;
    else if (token.text === closer) {
      depth -= 1;
      if (depth === 0) return index;
    } else if (token.text === "}" && closer !== "}") {
      // A brace closes a block that contains the bracket: the bracket is
      // unterminated, and the class ends where the block did.
      return -1;
    }
  }
  return -1;
}

/** Skips `<...>` from the `<` at `open`, or stays where it is when it is no type. */
function skipAngles(tokens: readonly Token[], open: number): number {
  if (!isPunct(tokens[open], "<")) return open;
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "punct") continue;
    if (token.text === "<") depth += 1;
    else if (token.text === ">") {
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (token.text === ";" || token.text === "{") return open;
  }
  return open;
}

/** The first name of a type annotation, or `"any"` where none is written. */
function typeNameAt(tokens: readonly Token[], index: number): string {
  const token = tokens[index];
  if (token === undefined || token.kind !== "ident") return "any";
  return token.text;
}

/**
 * Advances past a type annotation, stopping at one of `stops` at bracket depth
 * zero. Generic brackets are counted so `Array<number>` is one type and not a
 * comparison against a name.
 */
function skipType(tokens: readonly Token[], index: number, limit: number, stops: ReadonlySet<string>): number {
  let depth = 0;
  for (let at = index; at < limit; at += 1) {
    const token = tokens[at];
    if (token.kind !== "punct") continue;
    if (token.text === "<" || token.text === "(" || token.text === "[") depth += 1;
    else if (token.text === ">" || token.text === ")" || token.text === "]") {
      if (depth === 0) return at;
      depth -= 1;
    } else if (depth === 0 && stops.has(token.text)) return at;
  }
  return limit;
}

/** Advances past a value, stopping at the `;` or the class's closing `}`. */
function skipValue(tokens: readonly Token[], index: number, limit: number): number {
  let depth = 0;
  for (let at = index; at < limit; at += 1) {
    const token = tokens[at];
    if (token.kind !== "punct") continue;
    if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
    else if (token.text === ")" || token.text === "]" || token.text === "}") {
      if (depth === 0) return at;
      depth -= 1;
    } else if (token.text === ";" && depth === 0) return at;
  }
  return limit;
}

/** Reads a parameter list written from the `(` at `open`. */
function readParams(
  tokens: readonly Token[],
  open: number,
  limit: number,
  problems: ClassTable["problems"],
): { params: ClassParam[]; end: number } {
  const params: ClassParam[] = [];
  let index = open + 1;
  while (index < limit && !isPunct(tokens[index], ")")) {
    const line = tokens[index].line;
    let property = false;
    while (PARAM_MODIFIERS.has(tokens[index]?.text ?? "") && tokens[index]?.kind === "ident") {
      property = true;
      index += 1;
    }
    if (isPunct(tokens[index], ".") && isPunct(tokens[index + 1], ".") && isPunct(tokens[index + 2], ".")) {
      problems.push({
        message: "a rest parameter is not part of the class subset",
        detail: "write the parameters the method takes",
        line,
      });
      index += 3;
    }
    const nameToken = tokens[index];
    if (nameToken === undefined || nameToken.kind !== "ident") {
      problems.push({
        message: "expected a parameter name",
        detail: `near "${nameToken?.text ?? ""}"`,
        line,
      });
      // Move to the next comma so the remaining parameters are still read.
      while (index < limit && !isPunct(tokens[index], ",") && !isPunct(tokens[index], ")")) index += 1;
      if (isPunct(tokens[index], ",")) index += 1;
      continue;
    }
    const name = nameToken.text;
    index += 1;
    if (isPunct(tokens[index], "?")) index += 1;
    let typeName = "any";
    if (isPunct(tokens[index], ":")) {
      typeName = typeNameAt(tokens, index + 1);
      index = skipType(tokens, index + 1, limit, new Set([",", ")", "="]));
    }
    let defaultStart = -1;
    let defaultEnd = -1;
    if (isPunct(tokens[index], "=")) {
      index += 1;
      defaultStart = index;
      index = skipValue(tokens, index, limit);
      defaultEnd = index;
    }
    params.push({ name, typeName, property, defaultStart, defaultEnd, line });
    if (isPunct(tokens[index], ",")) {
      index += 1;
      continue;
    }
    break;
  }
  if (isPunct(tokens[index], ")")) index += 1;
  return { params, end: index };
}

/** Reads the class that starts at the `class` token at `start`. */
function readClass(tokens: readonly Token[], start: number, problems: ClassTable["problems"]): ClassInfo | null {
  const line = tokens[start].line;
  const exported = tokens[start - 1]?.text === "export" || tokens[start - 2]?.text === "export";
  const isDefault = tokens[start - 1]?.text === "default";
  let declarationStart = start;
  if (isDefault && tokens[start - 2]?.text === "export") declarationStart = start - 2;
  else if (tokens[start - 1]?.text === "export") declarationStart = start - 1;
  let index = start + 1;
  const nameToken = tokens[index];
  if (nameToken === undefined || nameToken.kind !== "ident") return null;
  const name = nameToken.text;
  index += 1;
  let base: string | null = null;
  if (tokens[index]?.text === "extends") {
    index += 1;
    if (tokens[index]?.kind === "ident") {
      base = tokens[index].text;
      index += 1;
    }
    if (isPunct(tokens[index], "<")) index = skipAngles(tokens, index);
  }
  // `implements` and the class's type parameters say nothing the lowering
  // needs, and they sit between the name and the body.
  while (index < tokens.length && !isPunct(tokens[index], "{")) index += 1;
  if (index >= tokens.length) return null;
  const open = index;
  const close = matching(tokens, open);
  if (close < 0) return null;

  const fields: ClassField[] = [];
  const statics: ClassField[] = [];
  const methods: ClassMethod[] = [];
  const staticMethods: ClassMethod[] = [];
  let constructor: ClassMethod | null = null;

  index = open + 1;
  while (index < close) {
    if (isPunct(tokens[index], ";")) {
      index += 1;
      continue;
    }
    const memberLine = tokens[index].line;
    let isStatic = false;
    while (tokens[index]?.kind === "ident" && MEMBER_MODIFIERS.has(tokens[index].text)) {
      if (tokens[index].text === "static") isStatic = true;
      index += 1;
    }
    if (index >= close) break;
    if (tokens[index].text === "constructor" && isPunct(tokens[index + 1], "(")) {
      const params = readParams(tokens, index + 1, close, problems);
      index = params.end;
      while (index < close && !isPunct(tokens[index], "{") && !isPunct(tokens[index], ";")) index += 1;
      if (isPunct(tokens[index], "{")) {
        const bodyClose = matching(tokens, index);
        if (bodyClose < 0) break;
        constructor = { name: "constructor", params: params.params, returnTypeName: name, bodyStart: index, bodyEnd: bodyClose + 1, line: memberLine };
        index = bodyClose + 1;
      } else {
        index += 1;
      }
      continue;
    }
    // An accessor is read as a method and refused by the parser: a property
    // read has no call to dispatch it with.
    let accessor: "get" | "set" | null = null;
    if ((tokens[index].text === "get" || tokens[index].text === "set") && tokens[index + 1]?.kind === "ident") {
      accessor = tokens[index].text as "get" | "set";
      index += 1;
    }
    const memberToken = tokens[index];
    if (memberToken === undefined || memberToken.kind !== "ident") {
      // A computed member, a string-named one, or a private `#name`: the name
      // the lowering needs is not written as a plain identifier.
      problems.push({
        message: "a class member is named with an identifier",
        detail: `near "${memberToken?.text ?? ""}"; write the member as a name`,
        line: memberLine,
      });
      index = skipValue(tokens, index, close);
      if (index < close) index += 1;
      continue;
    }
    const memberName = memberToken.text;
    index += 1;
    if (isPunct(tokens[index], "?") || isPunct(tokens[index], "!")) index += 1;
    if (isPunct(tokens[index], "<")) index = skipAngles(tokens, index);
    if (isPunct(tokens[index], "(")) {
      const params = readParams(tokens, index, close, problems);
      index = params.end;
      let returnTypeName = "any";
      if (isPunct(tokens[index], ":")) {
        returnTypeName = typeNameAt(tokens, index + 1);
        index = skipType(tokens, index + 1, close, new Set(["{", ";"]));
      }
      while (index < close && !isPunct(tokens[index], "{") && !isPunct(tokens[index], ";")) index += 1;
      let bodyStart = index;
      let bodyEnd = index;
      if (isPunct(tokens[index], "{")) {
        const bodyClose = matching(tokens, index);
        if (bodyClose < 0) break;
        bodyEnd = bodyClose + 1;
        index = bodyClose + 1;
      } else {
        index += 1;
      }
      if (accessor !== null) {
        problems.push({
          message: `a ${accessor} accessor is not supported`,
          detail: "write the member as a method and call it",
          line: memberLine,
        });
        continue;
      }
      if (bodyEnd <= bodyStart) {
        problems.push({
          message: `method "${memberName}" has no body`,
          detail: "a compiled method is a body of statements",
          line: memberLine,
        });
        continue;
      }
      (isStatic ? staticMethods : methods).push({
        name: memberName,
        params: params.params,
        returnTypeName,
        bodyStart,
        bodyEnd,
        line: memberLine,
      });
      continue;
    }
    let typeName = "any";
    if (isPunct(tokens[index], ":")) {
      typeName = typeNameAt(tokens, index + 1);
      index = skipType(tokens, index + 1, close, new Set(["=", ";"]));
    }
    let initStart = -1;
    let initEnd = -1;
    if (isPunct(tokens[index], "=")) {
      index += 1;
      initStart = index;
      index = skipValue(tokens, index, close);
      initEnd = index;
    }
    if (isPunct(tokens[index], ";")) index += 1;
    // A field initialised with a literal or `new C(...)` holds that type even
    // where the source wrote no annotation, which is what a use of the field
    // reads it at.
    if (typeName === "any" && initStart >= 0) {
      const first = tokens[initStart];
      if (first?.kind === "number") typeName = "number";
      else if (first?.kind === "bigint") typeName = "bigint";
      else if (first?.kind === "string") typeName = "string";
      else if (first?.text === "true" || first?.text === "false") typeName = "boolean";
      else if (first?.text === "new" && tokens[initStart + 1]?.kind === "ident") typeName = tokens[initStart + 1].text;
    }
    (isStatic ? statics : fields).push({ name: memberName, typeName, initStart, initEnd, line: memberLine });
  }

  return {
    name,
    base,
    fields,
    statics,
    constructor,
    methods,
    staticMethods,
    line,
    start: declarationStart,
    end: close + 1,
    exported,
    isDefault,
  };
}

/** Every class a file declares at its top level. */
export function scanClasses(tokens: readonly Token[]): ClassTable {
  const table: ClassTable = { names: new Set(), classes: new Map(), ordered: [], defaultName: null, problems: [] };
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "punct") {
      if (token.text === "{") depth += 1;
      else if (token.text === "}") depth = Math.max(0, depth - 1);
    }
    if (depth !== 0 || token.kind !== "ident" || token.text !== "class") continue;
    // `x.class` is a field named class, not a declaration.
    if (isPunct(tokens[index - 1], ".") || tokens[index + 1]?.kind !== "ident") continue;
    const info = readClass(tokens, index, table.problems);
    if (info === null) continue;
    table.names.add(info.name);
    table.classes.set(info.name, info);
    table.ordered.push(info);
    if (info.isDefault) table.defaultName = info.name;
    index = info.end - 1;
  }
  return table;
}

/** The tokens of a file with every top-level class declaration removed. */
export function withoutClasses(tokens: readonly Token[], table: ClassTable): Token[] {
  const removed = new Uint8Array(tokens.length);
  for (const info of table.ordered) {
    for (let index = info.start; index < info.end; index += 1) removed[index] = 1;
  }
  return tokens.filter((_token, index) => removed[index] === 0);
}

/** The method a class has under a name, as the class or the base it inherits from. */
export function findMethod(
  table: ClassTable,
  className: string,
  name: string,
  isStatic: boolean,
): { owner: string; method: ClassMethod } | null {
  let current: string | null = className;
  while (current !== null) {
    const info = table.classes.get(current);
    if (info === undefined) return null;
    const method = (isStatic ? info.staticMethods : info.methods).find((entry) => entry.name === name);
    if (method !== undefined) return { owner: info.name, method };
    current = info.base;
  }
  return null;
}

/** The field a class has under a name, as the class or the base it inherits from. */
export function findField(
  table: ClassTable,
  className: string,
  name: string,
  isStatic: boolean,
): { owner: string; field: ClassField } | null {
  let current: string | null = className;
  while (current !== null) {
    const info = table.classes.get(current);
    if (info === undefined) return null;
    const field = (isStatic ? info.statics : info.fields).find((entry) => entry.name === name);
    if (field !== undefined) return { owner: info.name, field };
    current = info.base;
  }
  return null;
}

/**
 * The name a call of a method is written by. An optional parameter makes the
 * method callable with fewer arguments, and each arity it can be called at is a
 * function of its own whose body passes the defaults the source wrote.
 */
export function methodFunctionName(owner: string, method: ClassMethod, arity: number): string {
  const base = method.name === "constructor" ? owner : `${owner}_${method.name}`;
  const required = requiredParams(method.params);
  if (arity === method.params.length) return base;
  if (arity >= required && arity < method.params.length) return `${base}__${arity}`;
  return base;
}

/** How many parameters a function must be given, which is every one without a default. */
export function requiredParams(params: readonly ClassParam[]): number {
  let required = 0;
  for (let index = 0; index < params.length; index += 1) {
    if (params[index].defaultStart < 0) required = index + 1;
  }
  return required;
}

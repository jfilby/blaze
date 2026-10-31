/**
 * TypeScript interfaces and type aliases, read as the types they name.
 *
 * A compiled module erases its types: an interface is not a value and a type
 * alias is not a statement. What the frontend still needs is the information
 * the erased text carries — a field is a list, a name is a text, an alias is a
 * map — because that is what decides that `contract.definition.calls` is an
 * array and `contract.function.name` is a text. Those questions are asked
 * before a body is lowered, so the declarations are read once, beside the
 * classes, and every annotation is answered against the same table.
 *
 * A declaration may also be written in another module and imported. A
 * declaration therefore carries the table it was written in, and a name inside
 * it resolves there rather than in the module that imported it. The module
 * graph links the exported names of each file into the importing table, and a
 * field of an imported interface resolves through the table of the file that
 * declared it.
 */

import type { PrimitiveTypeName } from "../core/types.ts";
import type { Token } from "./typescript.ts";

/** One property an interface declares, with the type the source wrote for it. */
export interface TypeField {
  name: string;
  /** The annotation as written, e.g. `readonly FunctionCall[]`. */
  typeName: string;
  optional: boolean;
  line: number;
}

/** An interface or a type alias, as the module that declares it wrote it. */
export interface TypeDecl {
  name: string;
  kind: "interface" | "alias";
  /** The names a generic declaration takes, in the order it writes them. */
  params: string[];
  /** What an interface extends, as the type each name is written with. */
  extends: string[];
  /** The fields an interface declares, by the name each is read under. */
  fields: Map<string, TypeField>;
  /** The value an index signature holds, or null where none is written. */
  index: string | null;
  /** What an alias names, or null for an interface. */
  target: string | null;
  exported: boolean;
  line: number;
  /** The table the declaration was written in; its names resolve there. */
  scope: TypeTable;
}

/** Every type declaration one module holds, and the names it imports. */
export interface TypeTable {
  /** The declarations the module itself writes. */
  declarations: Map<string, TypeDecl>;
  /** The declarations another module offers, under the names this one binds. */
  imported: Map<string, TypeDecl>;
  /** The declarations this module offers to its importers. */
  exported: Map<string, TypeDecl>;
  /** The classes the module declares, which name a reference. */
  classes: ReadonlySet<string>;
}

/**
 * A type after aliases and generic arguments are read.
 *
 * This is what a member chain asks: a record says what its fields hold, a list
 * says what an element is, and a map says what its value is. It is not the
 * contract's type: a record is still the opaque reference a contract holds, but
 * the fields it names are what makes the next member of the chain readable.
 */
export type ResolvedType =
  | { kind: "primitive"; name: PrimitiveTypeName }
  | { kind: "text" }
  | { kind: "list"; of: ResolvedType }
  | { kind: "map"; key: ResolvedType; value: ResolvedType }
  | { kind: "set"; of: ResolvedType }
  | { kind: "record"; fields: Map<string, ResolvedField>; index: ResolvedType | null }
  | { kind: "function"; params: ResolvedType[]; returns: ResolvedType }
  | { kind: "ref"; name: string | null }
  /** The absent value of a union, which a value this compiler holds has not. */
  | { kind: "absent" }
  | { kind: "any" };

export interface ResolvedField {
  type: ResolvedType;
  optional: boolean;
}

/** The type an empty annotation reads as. */
export const ANY_TYPE: ResolvedType = { kind: "any" };

const PRIMITIVES: Record<string, PrimitiveTypeName> = {
  number: "f64",
  bigint: "i64",
  boolean: "bool",
  i256: "i256",
  u256: "u256",
};

const TYPED_ARRAYS: Record<string, PrimitiveTypeName> = {
  Float32Array: "f32",
  Float64Array: "f64",
  Int8Array: "i8",
  Int16Array: "i16",
  Int32Array: "i32",
  Int64Array: "i64",
  Uint8Array: "u8",
  Uint16Array: "u16",
  Uint32Array: "u32",
  BigInt64Array: "i64",
  BigUint64Array: "u64",
};

/* -------------------------------------------------------------------------- */
/* Reading the declarations                                                   */
/* -------------------------------------------------------------------------- */

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === "punct" && token.text === text;
}

/** The token after the `}` or `)` at `open`, or -1 where it is unterminated. */
function matching(tokens: readonly Token[], open: number): number {
  const opener = tokens[open]?.text;
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : opener === "[" ? "]" : "";
  if (closer === "") return -1;
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "punct") continue;
    if (token.text === opener) depth += 1;
    else if (token.text === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The index of the `>` that closes the `<` at `open`, or -1. */
function matchingAngles(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "punct") continue;
    if (token.text === "<") depth += 1;
    else if (token.text === ">") {
      depth -= 1;
      if (depth === 0) return index;
    } else if (token.text === ">>") {
      depth -= 2;
      if (depth <= 0) return index;
    } else if (token.text === ">>>") {
      depth -= 3;
      if (depth <= 0) return index;
    }
  }
  return -1;
}

function needsSpace(previous: Token, next: Token): boolean {
  const before = previous.text.slice(-1);
  const after = next.text.charAt(0);
  return /[A-Za-z0-9_$>]/.test(before) && /[A-Za-z0-9_$]/.test(after);
}

/**
 * The text of a run of type tokens.
 *
 * The tokens are joined the way the source wrote the type, not the way the
 * lexer split it: a name and the word before it keep the space that separates
 * them, so `readonly FunctionCall[]` does not read as one identifier, while
 * `Map<string, number>` keeps the shape the angle brackets give it.
 */
export function typeText(tokens: readonly Token[], from: number, to: number): string {
  let out = "";
  let previous: Token | undefined;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.kind === "string") {
      const quote = token.quote === "'" ? "'" : '"';
      let escaped = "";
      for (let at = 0; at < token.text.length; at += 1) {
        const char = token.text[at] as string;
        if (char === "\\" || char === quote) escaped += "\\";
        escaped += char;
      }
      out += `${quote}${escaped}${quote}`;
      previous = token;
      continue;
    }
    if (previous !== undefined && needsSpace(previous, token)) out += " ";
    out += token.text;
    previous = token;
  }
  return out;
}

/** Where a member's type ends: the `;`, `,` or closing brace at depth zero. */
function memberEnd(tokens: readonly Token[], from: number, close: number): number {
  let depth = 0;
  for (let index = from; index < close; index += 1) {
    const token = tokens[index];
    if (token.kind !== "punct") continue;
    const text = token.text;
    if (text === "(" || text === "[" || text === "{" || text === "<") depth += 1;
    else if (text === ")" || text === "]" || text === "}" || text === ">") depth -= 1;
    else if (text === ">>") depth -= 2;
    else if (text === ">>>") depth -= 3;
    else if (depth <= 0 && (text === ";" || text === ",")) return index;
    if (depth < 0) return index;
  }
  return close;
}

/** The names a `<...>` declares, with their bounds and defaults erased. */
function typeParameters(tokens: readonly Token[], at: number): { names: string[]; end: number } {
  if (!isPunct(tokens[at], "<")) return { names: [], end: at };
  const close = matchingAngles(tokens, at);
  if (close < 0) return { names: [], end: at };
  const names: string[] = [];
  let depth = 1;
  let expectName = true;
  for (let index = at + 1; index < close; index += 1) {
    const token = tokens[index];
    if (token.kind === "punct") {
      if (token.text === "<" || token.text === "(" || token.text === "[") depth += 1;
      else if (token.text === ">" || token.text === ")" || token.text === "]") depth -= 1;
      else if (token.text === ">>") depth -= 2;
      else if (token.text === ">>>") depth -= 3;
      else if (depth === 1 && token.text === ",") expectName = true;
      else if (depth === 1 && (token.text === "extends" || token.text === "=")) expectName = false;
      continue;
    }
    if (depth === 1 && expectName && token.kind === "ident") {
      names.push(token.text);
      expectName = false;
    }
  }
  return { names, end: close + 1 };
}

/** The members an interface body declares, from its `{` to its `}`. */
function interfaceMembers(
  tokens: readonly Token[],
  open: number,
  close: number,
  fields: Map<string, TypeField>,
  index: { value: string | null },
): void {
  let at = open + 1;
  while (at < close) {
    while (at < close && (isPunct(tokens[at], ";") || isPunct(tokens[at], ","))) at += 1;
    if (at >= close) break;
    if (tokens[at].text === "readonly") at += 1;
    // An index signature names the type a key reads as, not a field.
    if (isPunct(tokens[at], "[")) {
      const bracket = matching(tokens, at);
      if (bracket < 0) return;
      at = bracket + 1;
      if (isPunct(tokens[at], ":")) {
        const start = at + 1;
        const end = memberEnd(tokens, start, close);
        index.value = typeText(tokens, start, end);
        at = end;
      }
      continue;
    }
    // A call signature describes a callable interface rather than a field; it
    // names no member the source reads by name, so it is read past.
    if (isPunct(tokens[at], "(")) {
      const paren = matching(tokens, at);
      if (paren < 0) return;
      at = paren + 1;
      if (isPunct(tokens[at], ":")) at = memberEnd(tokens, at + 1, close);
      continue;
    }
    // A computed name is not a name the source reads; it is skipped with the
    // member it introduces.
    if (isPunct(tokens[at], "[")) {
      const bracket = matching(tokens, at);
      if (bracket < 0) return;
      at = bracket + 1;
      if (isPunct(tokens[at], ":")) at = memberEnd(tokens, at + 1, close);
      continue;
    }
    const name = tokens[at];
    if (name.kind !== "ident" && name.kind !== "string" && name.kind !== "number") {
      at += 1;
      continue;
    }
    at += 1;
    let optional = false;
    if (isPunct(tokens[at], "?")) {
      optional = true;
      at += 1;
    }
    if (isPunct(tokens[at], "<")) at = matchingAngles(tokens, at) + 1;
    if (isPunct(tokens[at], "(")) {
      const paren = matching(tokens, at);
      if (paren < 0) return;
      const params = typeText(tokens, at, paren + 1);
      let returns = "any";
      at = paren + 1;
      if (isPunct(tokens[at], ":")) {
        const start = at + 1;
        const end = memberEnd(tokens, start, close);
        returns = typeText(tokens, start, end);
        at = end;
      }
      fields.set(name.text, {
        name: name.text,
        typeName: `${params} => ${returns}`,
        optional,
        line: name.line,
      });
      continue;
    }
    if (isPunct(tokens[at], ":")) {
      const start = at + 1;
      const end = memberEnd(tokens, start, close);
      fields.set(name.text, { name: name.text, typeName: typeText(tokens, start, end), optional, line: name.line });
      at = end;
      continue;
    }
    // A property with no annotation is the opaque reference.
    fields.set(name.text, { name: name.text, typeName: "any", optional, line: name.line });
    if (isPunct(tokens[at], ";") || isPunct(tokens[at], ",")) at += 1;
  }
}

/** A helper that keeps the index arithmetic above readable. */

/**
 * Every interface and type alias one module writes.
 *
 * Only a declaration at the top of the file is read: a type written inside a
 * function is that body's own and names nothing the module exports, and the
 * declarations nested inside a class are not TypeScript declarations.
 */
export function scanTypeTable(tokens: readonly Token[]): TypeTable {
  const table: TypeTable = {
    declarations: new Map(),
    imported: new Map(),
    exported: new Map(),
    classes: new Set(),
  };
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "punct") {
      if (token.text === "{") {
        depth += 1;
        continue;
      }
      if (token.text === "}") {
        depth = Math.max(0, depth - 1);
        continue;
      }
    }
    if (depth !== 0) continue;
    let at = index;
    let exported = false;
    if (tokens[at]?.text === "export") {
      exported = true;
      at += 1;
      if (tokens[at]?.text === "declare") at += 1;
    } else if (tokens[at]?.text === "declare") {
      at += 1;
    }
    if (tokens[at]?.text === "interface" && tokens[at + 1]?.kind === "ident") {
      const name = tokens[at + 1] as Token;
      at += 2;
      const params = typeParameters(tokens, at);
      at = params.end;
      const extends_: string[] = [];
      if (tokens[at]?.text === "extends") {
        at += 1;
        const start = at;
        let nested = 0;
        while (at < tokens.length) {
          const one = tokens[at] as Token;
          if (one.kind === "punct") {
            if (one.text === "<" || one.text === "(" || one.text === "[") nested += 1;
            else if (one.text === ">") nested -= 1;
            else if (one.text === ">>") nested -= 2;
            else if (one.text === ">>>") nested -= 3;
            else if (one.text === ")" || one.text === "]") nested -= 1;
            else if (nested === 0 && one.text === "{") break;
          }
          at += 1;
        }
        const written = typeText(tokens, start, at);
        let depth = 0;
        let from = 0;
        for (let index = 0; index <= written.length; index += 1) {
          const char = written[index];
          if (char === "<" || char === "(" || char === "[") depth += 1;
          else if (char === ">" || char === ")" || char === "]") depth -= 1;
          else if ((char === "," && depth === 0) || index === written.length) {
            const part = written.slice(from, index).trim();
            if (part !== "") extends_.push(part);
            from = index + 1;
          }
        }
      }
      while (at < tokens.length && tokens[at]?.text !== "{") at += 1;
      if (at >= tokens.length) break;
      const close = matching(tokens, at);
      if (close < 0) break;
      const fields = new Map<string, TypeField>();
      const indexType = { value: null as string | null };
      interfaceMembers(tokens, at, close, fields, indexType);
      const decl: TypeDecl = {
        name: name.text,
        kind: "interface",
        params: params.names,
        extends: extends_.filter((entry) => entry.trim() !== ""),
        fields,
        index: indexType.value,
        target: null,
        exported,
        line: name.line,
        scope: table,
      };
      table.declarations.set(decl.name, decl);
      if (exported) table.exported.set(decl.name, decl);
      index = close;
      depth = 0;
      continue;
    }
    if (tokens[at]?.text === "type" && tokens[at + 1]?.kind === "ident") {
      const name = tokens[at + 1] as Token;
      // `type { A, B } from "./x.ts"` names types another module declares and
      // is not an alias this one writes.
      if (tokens[at + 2]?.text === "{") continue;
      if (tokens[at + 2]?.text !== "=" && tokens[at + 2]?.text !== "<") continue;
      at += 2;
      const params = typeParameters(tokens, at);
      at = params.end;
      if (tokens[at]?.text !== "=") continue;
      const start = at + 1;
      let end = start;
      let nested = 0;
      while (end < tokens.length) {
        const one = tokens[end] as Token;
        if (one.kind === "punct") {
          if (one.text === "(" || one.text === "[" || one.text === "{" || one.text === "<") nested += 1;
          else if (one.text === ")" || one.text === "]" || one.text === "}" || one.text === ">") nested -= 1;
          else if (one.text === ">>") nested -= 2;
          else if (one.text === ">>>") nested -= 3;
          else if (nested <= 0 && one.text === ";") break;
        }
        end += 1;
      }
      const decl: TypeDecl = {
        name: name.text,
        kind: "alias",
        params: params.names,
        extends: [],
        fields: new Map(),
        index: null,
        target: typeText(tokens, start, end),
        exported,
        line: name.line,
        scope: table,
      };
      table.declarations.set(decl.name, decl);
      if (exported) table.exported.set(decl.name, decl);
      index = end;
      depth = 0;
    }
  }
  // `export { type A, B };` offers a declaration written earlier under a name
  // the export list writes. The functions of a module are offered the same way,
  // and a type is no different.
  exportTypeLists(tokens, table);
  return table;
}

/** Marks the declarations an `export { ... }` list offers. */
function exportTypeLists(tokens: readonly Token[], table: TypeTable): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== "export") continue;
    let at = index + 1;
    if (tokens[at]?.text === "type") at += 1;
    if (tokens[at]?.text !== "{") continue;
    const close = matching(tokens, at);
    if (close < 0) continue;
    for (let one = at + 1; one < close; one += 1) {
      let local = tokens[one];
      if (local?.text === "type") local = tokens[++one];
      if (local?.kind !== "ident") continue;
      const decl = table.declarations.get(local.text);
      if (decl !== undefined) {
        decl.exported = true;
        table.exported.set(decl.name, decl);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Resolving a type                                                           */
/* -------------------------------------------------------------------------- */

/** The declaration a name binds, in the table and then among its imports. */
export function typeDeclared(table: TypeTable, name: string): TypeDecl | undefined {
  return table.declarations.get(name) ?? table.imported.get(name);
}

function resolveTypeText(
  table: TypeTable,
  text: string,
  params: ReadonlyMap<string, ResolvedType> = new Map(),
  seen: Set<TypeDecl> = new Set(),
): ResolvedType {
  return new TypeText(text, table, params, seen).parse();
}

function instantiate(
  decl: TypeDecl,
  args: readonly ResolvedType[],
  seen: Set<TypeDecl>,
): ResolvedType {
  const scope = decl.scope;
  const params = new Map<string, ResolvedType>();
  for (let index = 0; index < decl.params.length; index += 1) {
    params.set(decl.params[index] as string, args[index] ?? ANY_TYPE);
  }
  if (decl.kind === "alias") {
    if (seen.has(decl)) return { kind: "ref", name: decl.name };
    seen.add(decl);
    try {
      return resolveTypeText(scope, decl.target ?? "any", params, seen);
    } finally {
      seen.delete(decl);
    }
  }
  if (seen.has(decl)) return { kind: "ref", name: decl.name };
  seen.add(decl);
  try {
    const fields = new Map<string, ResolvedField>();
    let index: ResolvedType | null = null;
    for (const base of decl.extends) {
      const parent = resolveTypeText(scope, base, params, seen);
      mergeInto(fields, parent, seen);
      if (parent.kind === "record" && parent.index !== null) index = parent.index;
    }
    for (const field of decl.fields.values()) {
      fields.set(field.name, {
        type: resolveTypeText(scope, field.typeName, params, seen),
        optional: field.optional,
      });
    }
    if (decl.index !== null) index = resolveTypeText(scope, decl.index, params, seen);
    return { kind: "record", fields, index };
  } finally {
    seen.delete(decl);
  }
}

/** Lays a parent's fields into a child's, as `extends` does. */
function mergeInto(fields: Map<string, ResolvedField>, parent: ResolvedType, _seen: Set<TypeDecl>): void {
  if (parent.kind !== "record") return;
  for (const [name, field] of parent.fields) {
    if (!fields.has(name)) fields.set(name, field);
  }
}

/**
 * The field a member read names, or null where the type does not name one.
 *
 * A reference is resolved in the table it is read in; an imported declaration
 * carries its own scope, so a field of one resolves in the module that wrote
 * it.
 */
export function fieldOfType(table: TypeTable, base: ResolvedType, field: string): ResolvedField | null {
  return fieldOfTypeSeen(table, base, field, new Set());
}

function fieldOfTypeSeen(
  table: TypeTable,
  base: ResolvedType,
  field: string,
  seen: Set<TypeDecl>,
): ResolvedField | null {
  if (base.kind === "record") return base.fields.get(field) ?? null;
  if (base.kind === "ref" && base.name !== null) {
    const decl = typeDeclared(table, base.name);
    if (decl !== undefined && !seen.has(decl)) {
      seen.add(decl);
      const resolved = instantiate(decl, [], seen);
      if (resolved.kind === "record") return resolved.fields.get(field) ?? null;
    }
  }
  return null;
}

/** What an index read of a type answers, or null where the type names none. */
export function elementOfType(table: TypeTable, base: ResolvedType): ResolvedType | null {
  if (base.kind === "list") return base.of;
  if (base.kind === "record" && base.index !== null) return base.index;
  if (base.kind === "ref" && base.name !== null) {
    const decl = typeDeclared(table, base.name);
    if (decl !== undefined) {
      const resolved = instantiate(decl, [], new Set());
      if (resolved.kind === "record" && resolved.index !== null) return resolved.index;
    }
  }
  return null;
}

/** The `Map` or `Set` a type names, or null where it names neither. */
export function collectionOfType(type: ResolvedType): { kind: "map"; key: ResolvedType; value: ResolvedType } | { kind: "set"; of: ResolvedType } | null {
  if (type.kind === "map") return { kind: "map", key: type.key, value: type.value };
  if (type.kind === "set") return { kind: "set", of: type.of };
  return null;
}

/** A small recursive-descent reader over the text of a type annotation. */
class TypeText {
  private at = 0;
  private readonly text: string;
  private readonly table: TypeTable;
  private readonly params: ReadonlyMap<string, ResolvedType>;
  private readonly seen: Set<TypeDecl>;

  constructor(
    text: string,
    table: TypeTable,
    params: ReadonlyMap<string, ResolvedType>,
    seen: Set<TypeDecl>,
  ) {
    this.text = text;
    this.table = table;
    this.params = params;
    this.seen = seen;
  }

  parse(): ResolvedType {
    const type = this.union();
    this.space();
    return type;
  }

  private union(): ResolvedType {
    const members = [this.intersection()];
    while (this.take("|")) members.push(this.intersection());
    if (members.length === 1) return members[0] as ResolvedType;
    const present = members.filter((member) => member.kind !== "absent");
    if (present.length === 0) return { kind: "absent" };
    if (present.length === 1) return present[0] as ResolvedType;
    // A union of records names the fields both write; a union of anything else
    // is the one member this compiler's values can hold. The first present
    // member is that one, which is the rule the frontend already used.
    if (present.every((member) => member.kind === "record")) {
      const fields = new Map<string, ResolvedField>();
      let index: ResolvedType | null = null;
      for (const member of present) {
        if (member.kind !== "record") continue;
        for (const [name, field] of member.fields) {
          if (!fields.has(name)) fields.set(name, { type: field.type, optional: true });
        }
        if (member.index !== null) index = member.index;
      }
      return { kind: "record", fields, index };
    }
    return present[0] as ResolvedType;
  }

  private intersection(): ResolvedType {
    let type = this.postfix();
    while (this.take("&")) {
      const right = this.postfix();
      if (type.kind === "record" && right.kind === "record") {
        const fields = new Map(type.fields);
        for (const [name, field] of right.fields) {
          if (!fields.has(name)) fields.set(name, field);
        }
        type = { kind: "record", fields, index: type.index ?? right.index };
      } else if (type.kind === "any") {
        type = right;
      }
    }
    return type;
  }

  private postfix(): ResolvedType {
    let type = this.primary();
    for (;;) {
      this.space();
      if (!this.take("[")) return type;
      this.space();
      if (this.take("]")) type = { kind: "list", of: type };
      else {
        // A tuple is a list of the values it names.
        const first = this.union();
        while (this.take(",")) this.union();
        this.take("]");
        type = { kind: "list", of: first };
      }
    }
  }

  private primary(): ResolvedType {
    this.space();
    if (this.at >= this.text.length) return ANY_TYPE;
    // `readonly T[]` is the list `T[]` is.
    if (this.word("readonly")) return this.postfix();
    if (this.text[this.at] === "(") {
      const save = this.at;
      this.skipBalanced("(", ")");
      this.space();
      if (this.take("=>")) return { kind: "function", params: [], returns: this.union() };
      this.at = save + 1;
      const inner = this.union();
      this.space();
      this.take(")");
      return inner;
    }
    if (this.text[this.at] === "{") {
      const close = this.findBalanced(this.at, "{", "}");
      if (close < 0) return ANY_TYPE;
      const inner = this.text.slice(this.at + 1, close);
      this.at = close + 1;
      return this.record(inner);
    }
    if (this.text[this.at] === "[") {
      const save = this.at;
      this.skipBalanced("[", "]");
      // A tuple text only reaches here when the postfix reader did not see it;
      // the first member is what the index answers.
      this.at = save + 1;
      if (this.take("]")) return { kind: "list", of: ANY_TYPE };
      const first = this.union();
      while (this.take(",")) this.union();
      this.take("]");
      return { kind: "list", of: first };
    }
    if (this.text[this.at] === "'" || this.text[this.at] === '"' || this.text[this.at] === "`") {
      this.stringLiteral();
      return { kind: "text" };
    }
    const name = this.name();
    if (name === null) {
      this.at += 1;
      return ANY_TYPE;
    }
    const lower = name;
    if (lower === "null" || lower === "undefined" || lower === "void") return { kind: "absent" };
    if (lower === "any" || lower === "unknown" || lower === "never" || lower === "object") return ANY_TYPE;
    if (lower === "true" || lower === "false") return { kind: "primitive", name: "bool" };
    if (lower === "this") return ANY_TYPE;
    if (lower === "string") return { kind: "text" };
    if (lower === "keyof" || lower === "typeof" || lower === "infer" || lower === "unique" || lower === "new") {
      this.union();
      return ANY_TYPE;
    }
    if (lower in PRIMITIVES) return { kind: "primitive", name: PRIMITIVES[lower] as PrimitiveTypeName };
    if (lower in TYPED_ARRAYS) return { kind: "list", of: { kind: "primitive", name: TYPED_ARRAYS[lower] as PrimitiveTypeName } };
    const args = this.arguments();
    const first = args[0] ?? ANY_TYPE;
    switch (lower) {
      case "Array":
      case "ReadonlyArray":
        return { kind: "list", of: first };
      case "Map":
      case "WeakMap":
      case "ReadonlyMap":
        return { kind: "map", key: args[0] ?? { kind: "text" }, value: args[1] ?? ANY_TYPE };
      case "Set":
      case "WeakSet":
      case "ReadonlySet":
        return { kind: "set", of: first };
      case "Promise":
      case "Readonly":
      case "Partial":
      case "Required":
      case "NonNullable":
      case "Awaited":
        return first;
      case "Record":
        return { kind: "record", fields: new Map(), index: args[1] ?? ANY_TYPE };
      case "Function":
        return { kind: "function", params: [], returns: ANY_TYPE };
    }
    const param = this.params.get(lower);
    if (param !== undefined) return param;
    const decl = typeDeclared(this.table, lower);
    if (decl !== undefined) return instantiate(decl, args, this.seen);
    if (this.table.classes.has(lower)) return { kind: "ref", name: lower };
    return ANY_TYPE;
  }

  /** The `<...>` arguments of a generic name, or an empty list. */
  private arguments(): ResolvedType[] {
    this.space();
    if (!this.take("<")) return [];
    const args: ResolvedType[] = [];
    this.space();
    if (this.take(">")) return args;
    for (;;) {
      args.push(this.union());
      this.space();
      if (this.take(",")) continue;
      // `>>` and `>>>` close more than one generic; the one this reader is in
      // consumes the first `>` and leaves the rest for its caller.
      if (this.text.startsWith(">>", this.at)) {
        this.at += 1;
        return args;
      }
      if (this.text.startsWith(">>>", this.at)) {
        this.at += 1;
        return args;
      }
      this.take(">");
      return args;
    }
  }

  /** The fields of an inline object type, written between two braces. */
  private record(text: string): ResolvedType {
    const fields = new Map<string, ResolvedField>();
    let index: ResolvedType | null = null;
    const parts = this.splitMembers(text);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("[")) {
        const colon = trimmed.indexOf(":");
        if (colon >= 0) index = resolveTypeText(this.table, trimmed.slice(colon + 1), this.params, this.seen);
        continue;
      }
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(trimmed);
      if (name === null) continue;
      let rest = trimmed.slice(name[0].length).trim();
      const optional = rest.startsWith("?");
      if (optional) rest = rest.slice(1).trim();
      if (!rest.startsWith(":")) continue;
      const type = rest.slice(1).trim();
      fields.set(name[0], { type: resolveTypeText(this.table, type, this.params, this.seen), optional });
    }
    return { kind: "record", fields, index };
  }

  /** The `;`-separated members of an object type, at brace depth zero. */
  private splitMembers(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] as string;
      if (char === "{" || char === "(" || char === "[" || char === "<") depth += 1;
      else if (char === "}" || char === ")" || char === "]" || char === ">") depth -= 1;
      else if ((char === ";" || char === ",") && depth === 0) {
        out.push(text.slice(start, index));
        start = index + 1;
      }
    }
    out.push(text.slice(start));
    return out;
  }

  private name(): string | null {
    this.space();
    const start = this.at;
    while (this.at < this.text.length && /[A-Za-z0-9_$.]/.test(this.text[this.at] as string)) this.at += 1;
    if (this.at === start) return null;
    return this.text.slice(start, this.at);
  }

  private word(word: string): boolean {
    this.space();
    if (!this.text.startsWith(word, this.at)) return false;
    const after = this.text[this.at + word.length];
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) return false;
    this.at += word.length;
    return true;
  }

  private stringLiteral(): void {
    const quote = this.text[this.at] as string;
    this.at += 1;
    while (this.at < this.text.length) {
      const char = this.text[this.at] as string;
      if (char === "\\") this.at += 2;
      else if (char === quote) {
        this.at += 1;
        return;
      } else this.at += 1;
    }
  }

  private skipBalanced(open: string, close: string): void {
    const end = this.findBalanced(this.at, open, close);
    this.at = end < 0 ? this.text.length : end + 1;
  }

  private findBalanced(from: number, open: string, close: string): number {
    let depth = 0;
    for (let index = from; index < this.text.length; index += 1) {
      const char = this.text[index] as string;
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  private space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at] as string)) this.at += 1;
  }

  private take(text: string): boolean {
    this.space();
    if (!this.text.startsWith(text, this.at)) return false;
    this.at += text.length;
    return true;
  }
}

/**
 * Resolves the annotation a run of tokens writes.
 *
 * The parser reads annotations as token runs, and the two forms — a class field
 * written as one name and a body annotation written as tokens — reach here as
 * the same text.
 */
export function resolveAnnotation(tokens: readonly Token[], from: number, to: number, table: TypeTable): ResolvedType {
  return resolveTypeText(table, typeText(tokens, from, to));
}

/** Resolves an annotation already written as one text, as a class field is. */
export function resolveTypeName(table: TypeTable, typeName: string): ResolvedType {
  return resolveTypeText(table, typeName);
}

/**
 * Binds the type declarations an import names to the declarations of the module
 * it imports.
 *
 * A type import is not a runtime import: nothing is loaded and no function is
 * linked. It only says what a name in this file means, and the declaration keeps
 * its own table so the fields written in the other module resolve there.
 */
export function bindImportedTypes(
  table: TypeTable,
  imports: readonly { specifier: string; names: readonly { local: string; imported: string }[] }[],
  targets: ReadonlyMap<string, TypeTable>,
): void {
  for (const entry of imports) {
    const target = targets.get(entry.specifier);
    if (target === undefined) continue;
    for (const name of entry.names) {
      const decl = target.exported.get(name.imported) ?? target.declarations.get(name.imported);
      if (decl === undefined) continue;
      table.imported.set(name.local, decl);
    }
  }
}

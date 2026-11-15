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

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

/** A mutable copy of an optional arm list, which the record type holds mutably. */
function copyArms(value: readonly ResolvedType[] | undefined): ResolvedType[] | undefined {
  return value === undefined ? undefined : [...value];
}

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
  /**
   * The table this one is written inside, when a block declares a type of its
   * own.
   *
   * A `type` or an `interface` written in a function body is in scope for that
   * body and no other, so the body is read against a table of its own that
   * falls back to the module's: the name a body declares shadows the one the
   * module writes, and a module never sees a name a body declared.
   */
  parent?: TypeTable;
  /** The declarations another module offers, under the names this one binds. */
  imported: Map<string, TypeDecl>;
  /** The declarations this module offers to its importers. */
  exported: Map<string, TypeDecl>;
  /**
   * The names this module offers under a name it did not declare, as
   * `export type { X }` writes where `X` is a type the module imported.
   *
   * What the name stands for is the declaration the module's own import binds,
   * and the module graph binds those after the file is read: the re-export is
   * resolved when the graph links the types, not where the list is written.
   */
  reexported: Set<string>;
  /** The classes the module declares, which name a reference. */
  classes: ReadonlySet<string>;
  /**
   * The expansions this table has already made, so a declaration of no
   * parameters is expanded once. It is the table's own state rather than a
   * module's, because a compiled function owns no module table.
   */
  expansions?: ExpansionStore;
}

/** The expansions one type table keeps, and the link they were read after. */
interface ExpansionStore {
  entries: WeakMap<TypeDecl, { generation: number; type: ResolvedType }>;
  generation: number;
}

function expansionsOf(table: TypeTable): ExpansionStore {
  const known = fieldOf(table, "expansions") as ExpansionStore | undefined;
  if (known !== undefined) return known;
  const made: ExpansionStore = { entries: new WeakMap(), generation: 0 };
  setFieldOn(table, "expansions", made);
  return made;
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
  | {
      kind: "record";
      fields: Map<string, ResolvedField>;
      index: ResolvedType | null;
      /**
       * The arms a union of records was written as, in the order the source
       * wrote them. A record built from an interface has no arms; one built
       * from a union keeps them so that a value can say which arm it is.
       */
      arms?: ResolvedType[];
      /**
       * The record is a pair written as a tuple, `readonly [key, value]`. The
       * language writes a tuple as an array, so its JSON is an array rather
       * than the object the two fields look like.
       */
      tuple?: true;
    }
  | { kind: "function"; params: ResolvedType[]; returns: ResolvedType }
  | { kind: "ref"; name: string | null }
  /** The absent value of a union, which a value this compiler holds has not. */
  | { kind: "absent" }
  | { kind: "any" };

export interface ResolvedField {
  type: ResolvedType;
  optional: boolean;
  /**
   * The literals a field is declared as, where its annotation is one.
   *
   * A union of records is discriminated by a field such as `k: "buffer"`, and
   * the resolved type keeps only that the field is a text. The literal is what
   * a test `value.k === "buffer"` narrows the union by, so it is kept here.
   */
  literal?: string;
  /**
   * Every literal a field's annotation writes, as in `k: "buffer" | "sized"`.
   * An intersection narrows a union by these, which is why the whole list is
   * kept beside the one a simple tag writes.
   */
  literals?: readonly string[];
  /**
   * The names the field's annotation wrote that no declaration of the module
   * that wrote it holds.
   *
   * A name this file imports is a declaration another module writes, and the
   * module graph links it after the file is read: a value read through a field
   * of that type waits for the link rather than being called `any`.
   */
  unlinked?: readonly string[];
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

/** The words a member of an object type may write in front of its name. */
const RECORD_MODIFIERS: ReadonlySet<string> = new Set(["readonly", "public", "private", "protected", "override"]);

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
  return token !== undefined && String(fieldOf(token, "kind")) === "punct" && String(fieldOf(token, "text")) === text;
}

/** The text of the token at `at`, or the empty text where none stands. */
function tokenTextAt(tokens: readonly Token[], at: number): string {
  const token: Token | undefined = tokens[at];
  return token === undefined ? "" : String(fieldOf(token, "text"));
}

/** The kind of the token at `at`, or the empty kind where none stands. */
function tokenKindAt(tokens: readonly Token[], at: number): string {
  const token: Token | undefined = tokens[at];
  return token === undefined ? "" : String(fieldOf(token, "kind"));
}

/** The token after the `}` or `)` at `open`, or -1 where it is unterminated. */
function matching(tokens: readonly Token[], open: number): number {
  const openToken = tokens[open];
  const opener = openToken === undefined ? "" : String(fieldOf(openToken, "text"));
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : opener === "[" ? "]" : "";
  if (closer === "") return -1;
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (String(fieldOf(token, "kind")) !== "punct") continue;
    const text = String(fieldOf(token, "text"));
    if (text === opener) depth += 1;
    else if (text === closer) {
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
    if (String(fieldOf(token, "kind")) !== "punct") continue;
    const text = String(fieldOf(token, "text"));
    if (text === "<") depth += 1;
    else if (text === ">") {
      depth -= 1;
      if (depth === 0) return index;
    } else if (text === ">>") {
      depth -= 2;
      if (depth <= 0) return index;
    } else if (text === ">>>") {
      depth -= 3;
      if (depth <= 0) return index;
    }
  }
  return -1;
}

function needsSpace(previous: Token, next: Token): boolean {
  const before = String(fieldOf(previous, "text")).slice(-1);
  const after = String(fieldOf(next, "text")).charAt(0);
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
    if (String(fieldOf(token, "kind")) === "string") {
      const quote = /^\x27$/.test(String(fieldOf(token, "quote"))) ? "\x27" : '"';
      const text = String(fieldOf(token, "text"));
      let escaped = "";
      for (let at = 0; at < text.length; at += 1) {
        const char = text.slice(at, at + 1);
        if (char === "\\" || char === quote) escaped += "\\";
        escaped += char;
      }
      out += `${quote}${escaped}${quote}`;
      previous = token;
      continue;
    }
    if (previous !== undefined && needsSpace(previous, token)) out += " ";
    out += String(fieldOf(token, "text"));
    previous = token;
  }
  return out;
}

/** Where a member's type ends: the `;`, `,` or closing brace at depth zero. */
function memberEnd(tokens: readonly Token[], from: number, close: number): number {
  let depth = 0;
  for (let index = from; index < close; index += 1) {
    const token = tokens[index];
    if (String(fieldOf(token, "kind")) !== "punct") continue;
    const text = String(fieldOf(token, "text"));
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
    if (String(fieldOf(token, "kind")) === "punct") {
      const text = String(fieldOf(token, "text"));
      if (text === "<" || text === "(" || text === "[") depth += 1;
      else if (text === ">" || text === ")" || text === "]") depth -= 1;
      else if (text === ">>") depth -= 2;
      else if (text === ">>>") depth -= 3;
      else if (depth === 1 && text === ",") expectName = true;
      else if (depth === 1 && (text === "extends" || text === "=")) expectName = false;
      continue;
    }
    if (depth === 1 && expectName && String(fieldOf(token, "kind")) === "ident") {
      names.push(String(fieldOf(token, "text")));
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
    if (String(fieldOf(tokens[at], "text")) === "readonly") at += 1;
    // An index signature names the type a key reads as, not a field.
    if (isPunct(tokens[at], "[")) {
      const bracket = matching(tokens, at);
      if (bracket < 0) return;
      at = bracket + 1;
      if (isPunct(tokens[at], ":")) {
        const start = at + 1;
        const end = memberEnd(tokens, start, close);
        setFieldOn(index, "value", typeText(tokens, start, end));
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
    const nameKind = String(fieldOf(name, "kind"));
    if (nameKind !== "ident" && nameKind !== "string" && nameKind !== "number") {
      at += 1;
      continue;
    }
    const nameText = String(fieldOf(name, "text"));
    const nameLine = Number(fieldOf(name, "line"));
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
      fields.set(nameText, {
        name: nameText,
        typeName: `${params} => ${returns}`,
        optional,
        line: nameLine,
      });
      continue;
    }
    if (isPunct(tokens[at], ":")) {
      const start = at + 1;
      const end = memberEnd(tokens, start, close);
      fields.set(nameText, { name: nameText, typeName: typeText(tokens, start, end), optional, line: nameLine });
      at = end;
      continue;
    }
    // A property with no annotation is the opaque reference.
    fields.set(nameText, { name: nameText, typeName: "any", optional, line: nameLine });
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
    reexported: new Set(),
    classes: new Set(),
    expansions: undefined,
  };
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (String(fieldOf(token, "kind")) === "punct") {
      const text = String(fieldOf(token, "text"));
      if (text === "{") {
        depth += 1;
        continue;
      }
      if (text === "}") {
        depth = Math.max(0, depth - 1);
        continue;
      }
    }
    if (depth !== 0) continue;
    let at = index;
    let exported = false;
    if (tokenTextAt(tokens, at) === "export") {
      exported = true;
      at += 1;
      if (tokenTextAt(tokens, at) === "declare") at += 1;
    } else if (tokenTextAt(tokens, at) === "declare") {
      at += 1;
    }
    if (tokenTextAt(tokens, at) === "interface" && tokenKindAt(tokens, at + 1) === "ident") {
      const name = tokens[at + 1];
      const nameText = String(fieldOf(name, "text"));
      const nameLine = Number(fieldOf(name, "line"));
      at += 2;
      const params = typeParameters(tokens, at);
      at = params.end;
      const extends_: string[] = [];
      if (tokenTextAt(tokens, at) === "extends") {
        at += 1;
        const start = at;
        let nested = 0;
        while (at < tokens.length) {
          const one = tokens[at];
          const text = String(fieldOf(one, "text"));
          if (String(fieldOf(one, "kind")) === "punct") {
            if (text === "<" || text === "(" || text === "[") nested += 1;
            else if (text === ">") nested -= 1;
            else if (text === ">>") nested -= 2;
            else if (text === ">>>") nested -= 3;
            else if (text === ")" || text === "]") nested -= 1;
            else if (nested === 0 && text === "{") break;
          }
          at += 1;
        }
        const written = typeText(tokens, start, at);
        let depth = 0;
        let from = 0;
        for (let index = 0; index <= written.length; index += 1) {
          const char = written.slice(index, index + 1);
          if (char === "<" || char === "(" || char === "[") depth += 1;
          else if (char === ">" || char === ")" || char === "]") depth -= 1;
          else if ((char === "," && depth === 0) || index === written.length) {
            const part = written.slice(from, index).trim();
            if (part !== "") extends_.push(part);
            from = index + 1;
          }
        }
      }
      while (at < tokens.length && tokenTextAt(tokens, at) !== "{") at += 1;
      if (at >= tokens.length) break;
      const close = matching(tokens, at);
      if (close < 0) break;
      const fields = new Map<string, TypeField>();
      const indexType = { value: null as string | null };
      interfaceMembers(tokens, at, close, fields, indexType);
      const decl: TypeDecl = {
        name: nameText,
        kind: "interface",
        params: params.names,
        extends: extends_.filter((entry) => entry.trim() !== ""),
        fields,
        index: fieldOf(indexType, "value") as string | null,
        target: null,
        exported,
        line: nameLine,
        scope: table,
      };
      const declarations = fieldOf(table, "declarations") as Map<string, TypeDecl>;
      declarations.set(nameText, decl);
      if (exported) (fieldOf(table, "exported") as Map<string, TypeDecl>).set(nameText, decl);
      index = close;
      depth = 0;
      continue;
    }
    if (tokenTextAt(tokens, at) === "type" && tokenKindAt(tokens, at + 1) === "ident") {
      const name = tokens[at + 1];
      const nameText = String(fieldOf(name, "text"));
      const nameLine = Number(fieldOf(name, "line"));
      // `type { A, B } from "./x.ts"` names types another module declares and
      // is not an alias this one writes.
      if (tokenTextAt(tokens, at + 2) === "{") continue;
      if (tokenTextAt(tokens, at + 2) !== "=" && tokenTextAt(tokens, at + 2) !== "<") continue;
      at += 2;
      const params = typeParameters(tokens, at);
      at = params.end;
      if (tokenTextAt(tokens, at) !== "=") continue;
      const start = at + 1;
      let end = start;
      let nested = 0;
      while (end < tokens.length) {
        const one = tokens[end];
        const text = String(fieldOf(one, "text"));
        if (String(fieldOf(one, "kind")) === "punct") {
          if (text === "(" || text === "[" || text === "{" || text === "<") nested += 1;
          else if (text === ")" || text === "]" || text === "}" || text === ">") nested -= 1;
          else if (text === ">>") nested -= 2;
          else if (text === ">>>") nested -= 3;
          else if (nested <= 0 && text === ";") break;
        }
        end += 1;
      }
      const decl: TypeDecl = {
        name: nameText,
        kind: "alias",
        params: params.names,
        extends: [],
        fields: new Map(),
        index: null,
        target: typeText(tokens, start, end),
        exported,
        line: nameLine,
        scope: table,
      };
      const declarations = fieldOf(table, "declarations") as Map<string, TypeDecl>;
      declarations.set(nameText, decl);
      if (exported) (fieldOf(table, "exported") as Map<string, TypeDecl>).set(nameText, decl);
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
    if (tokenTextAt(tokens, index) !== "export") continue;
    let at = index + 1;
    if (tokenTextAt(tokens, at) === "type") at += 1;
    if (tokenTextAt(tokens, at) !== "{") continue;
    const close = matching(tokens, at);
    if (close < 0) continue;
    for (let one = at + 1; one < close; one += 1) {
      let local: Token | undefined = tokens[one];
      if (local !== undefined && String(fieldOf(local, "text")) === "type") local = tokens[++one];
      if (local === undefined || String(fieldOf(local, "kind")) !== "ident") continue;
      // `X as Y` offers X under the name Y, which is the name an importer
      // writes; a list of plain names offers each under its own.
      let offered = String(fieldOf(local, "text"));
      if (tokenTextAt(tokens, one + 1) === "as" && tokenKindAt(tokens, one + 2) === "ident") {
        offered = tokenTextAt(tokens, one + 2);
        one += 2;
      }
      const declarations = fieldOf(table, "declarations") as Map<string, TypeDecl>;
      const exported = fieldOf(table, "exported") as Map<string, TypeDecl>;
      const reexported = fieldOf(table, "reexported") as Set<string>;
      const decl = declarations.get(String(fieldOf(local, "text")));
      if (decl !== undefined) {
        setFieldOn(decl, "exported", true);
        exported.set(offered, decl);
        continue;
      }
      // A name the module did not write is one its imports bind: the export
      // list offers it under the name it writes, and what it stands for is the
      // declaration the module's own import resolves to. The module graph binds
      // those after the file is read, so the offer is resolved at the link.
      reexported.add(offered);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Resolving a type                                                           */
/* -------------------------------------------------------------------------- */

/** The declaration a name binds, in the table and then among its imports. */
export function typeDeclared(table: TypeTable, name: string): TypeDecl | undefined {
  // A table a block writes inside another falls back to the other, so a name
  // the block declares shadows the module's and a name it does not is the
  // module's still.
  let at: TypeTable | undefined = table;
  while (at !== undefined) {
    const declarations = fieldOf(at, "declarations") as Map<string, TypeDecl>;
    const imported = fieldOf(at, "imported") as Map<string, TypeDecl>;
    const found = declarations.get(name) ?? imported.get(name);
    if (found !== undefined) return found;
    at = fieldOf(at, "parent") as TypeTable | undefined;
  }
  return undefined;
}

function resolveTypeText(
  table: TypeTable,
  text: string,
  params: ReadonlyMap<string, ResolvedType> = new Map(),
  seen: Set<TypeDecl> = new Set(),
): ResolvedType {
  return new TypeText(text, table, params, seen).parse();
}

/**
 * The one expansion of a declaration a table has already made.
 *
 * A union of records names every field of every arm, and a declaration such as
 * the IR's `SemanticValue` names a field of nearly every type the program has.
 * Expanding it parses a thousand characters of type text, and a member read
 * asks for it again for every value it sees, so the same declaration was
 * expanded hundreds of thousands of times. An expansion depends on nothing but
 * the declaration, so it is made once and kept.
 *
 * Only an expansion made from the top of a type is kept: an expansion made
 * inside another one reads the names its parent already opened as references,
 * and that cut is part of the answer. The cut is the same for every expansion
 * that starts at the declaration, which is what is kept.
 *
 * An expansion is only as good as the table it was made in. A module is read
 * once before its imports are bound and again after, and a declaration read
 * before the link names the imported type it writes as `any`; keeping that
 * expansion would hide the declaration the link brought in. The generation
 * counts the links that have been made, so a kept expansion is read only by
 * the read that made it.
 */

function instantiate(
  decl: TypeDecl,
  args: readonly ResolvedType[],
  seen: Set<TypeDecl>,
  table: TypeTable,
): ResolvedType {
  // A generic declaration is expanded once per list of arguments, and this
  // table does not key that list, so it is expanded where it is asked for.
  const store = expansionsOf(table);
  const cacheable = seen.size === 0 && (fieldOf(decl, "params") as readonly string[]).length === 0;
  const entries = fieldOf(store, "entries") as WeakMap<TypeDecl, { readonly generation: number; readonly type: ResolvedType }>;
  const generation = Number(fieldOf(store, "generation"));
  if (cacheable) {
    const kept = entries.get(decl);
    if (kept !== undefined && Number(fieldOf(kept, "generation")) === generation) return fieldOf(kept, "type") as ResolvedType;
  }
  const built = instantiateUncached(decl, args, seen);
  if (cacheable) entries.set(decl, { generation, type: built });
  return built;
}

function instantiateUncached(
  decl: TypeDecl,
  args: readonly ResolvedType[],
  seen: Set<TypeDecl>,
): ResolvedType {
  const scope = fieldOf(decl, "scope") as TypeTable;
  const declParams = fieldOf(decl, "params") as readonly string[];
  const params = new Map<string, ResolvedType>();
  for (let index = 0; index < declParams.length; index += 1) {
    params.set(declParams[index], args[index] ?? ANY_TYPE);
  }
  const name = String(fieldOf(decl, "name"));
  if (String(fieldOf(decl, "kind")) === "alias") {
    if (seen.has(decl)) return { kind: "ref", name };
    seen.add(decl);
    try {
      return resolveTypeText(scope, String(fieldOf(decl, "target") ?? "any"), params, seen);
    } finally {
      seen.delete(decl);
    }
  }
  if (seen.has(decl)) return { kind: "ref", name };
  seen.add(decl);
  try {
    const fields = new Map<string, ResolvedField>();
    let index: ResolvedType | null = null;
    for (const base of fieldOf(decl, "extends") as readonly string[]) {
      const parent = resolveTypeText(scope, base, params, seen);
      mergeInto(fields, parent, seen);
      const parentIndex = fieldOf(parent, "index") as ResolvedType | null;
      if (String(fieldOf(parent, "kind")) === "record" && parentIndex !== null) index = parentIndex;
    }
    for (const field of (fieldOf(decl, "fields") as ReadonlyMap<string, { readonly name: string; readonly typeName: string; readonly optional: boolean }>).values()) {
      const fieldName = String(fieldOf(field, "name"));
      const typeName = String(fieldOf(field, "typeName"));
      const unlinked = namesNotDeclared(scope, typeName, params);
      const optional = fieldOf(field, "optional") === true;
      if (unlinked.length > 0) {
        fields.set(fieldName, { type: resolveTypeText(scope, typeName, params, seen), optional, unlinked });
      } else {
        fields.set(fieldName, { type: resolveTypeText(scope, typeName, params, seen), optional });
      }
    }
    const declIndex = fieldOf(decl, "index") as string | null;
    if (declIndex !== null) index = resolveTypeText(scope, declIndex, params, seen);
    return { kind: "record", fields, index };
  } finally {
    seen.delete(decl);
  }
}

/**
 * The names an annotation writes that the table it is written in does not hold.
 *
 * A name this module imports is a declaration another module writes, and the
 * module graph links it after the file is read. The read that stands alone keeps
 * the name so a value written at it waits for that link rather than being
 * called `any`. A name the language writes — `number`, `Array`, `Record` — is
 * kept here too, and the reader that asks is the one that knows its imports.
 */
function namesNotDeclared(
  scope: TypeTable,
  text: string,
  params: ReadonlyMap<string, ResolvedType>,
): string[] {
  const names: string[] = [];
  for (const name of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    if (params.has(name)) continue;
    if (typeDeclared(scope, name) !== undefined || (fieldOf(scope, "classes") as Set<string>).has(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Lays a parent's fields into a child's, as `extends` does. */
function mergeInto(fields: Map<string, ResolvedField>, parent: ResolvedType, _seen: Set<TypeDecl>): void {
  if (String(fieldOf(parent, "kind")) !== "record") return;
  for (const [name, field] of fieldOf(parent, "fields") as ReadonlyMap<string, ResolvedField>) {
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
  const baseKind = String(fieldOf(base, "kind"));
  if (baseKind === "record") return (fieldOf(base, "fields") as ReadonlyMap<string, ResolvedField>).get(field) ?? null;
  const refName = fieldOf(base, "name") as string | null;
  if (baseKind === "ref" && refName !== null) {
    const decl = typeDeclared(table, refName);
    // The declaration is not marked as seen before it is instantiated: the
    // expansion marks the declaration itself, and a name marked here reads as
    // the recursive reference the expansion answers with a `ref` before it has
    // written a field.
    if (decl !== undefined && !seen.has(decl)) {
      const resolved = instantiate(decl, [], seen, table);
      if (String(fieldOf(resolved, "kind")) === "record") return (fieldOf(resolved, "fields") as ReadonlyMap<string, ResolvedField>).get(field) ?? null;
    }
  }
  return null;
}

/** Every literal a field names, from its one literal or its list. */
function literalsOf(field: ResolvedField | undefined): readonly string[] {
  if (field === undefined) return [];
  const literals = fieldOf(field, "literals") as readonly string[] | undefined;
  if (literals !== undefined) return literals;
  const literal = fieldOf(field, "literal") as string | undefined;
  return literal === undefined ? [] : [literal];
}

/** The fields of a record with the ones another record adds. */
function withFields(fields: ReadonlyMap<string, ResolvedField>, add: ReadonlyMap<string, ResolvedField>): Map<string, ResolvedField> {
  const merged = new Map(fields);
  for (const [name, field] of add) if (!merged.has(name)) merged.set(name, field);
  return merged;
}

/** The union record of a list of arms, with the fields they share. */
function unionOfArms(arms: readonly ResolvedType[]): ResolvedType {
  if (arms.length === 1) return arms[0] as ResolvedType;
  const fields = new Map<string, ResolvedField>();
  let index: ResolvedType | null = null;
  for (const member of arms) {
    if (String(fieldOf(member, "kind")) !== "record") continue;
    for (const [name, field] of fieldOf(member, "fields") as ReadonlyMap<string, ResolvedField>) {
      if (!fields.has(name)) {
        const optional: ResolvedField = { type: fieldOf(field, "type") as ResolvedType, optional: true };
        const literal = fieldOf(field, "literal") as string | undefined;
        if (literal !== undefined) setFieldOn(optional, "literal", literal);
        const literals = fieldOf(field, "literals") as readonly string[] | undefined;
        if (literals !== undefined) setFieldOn(optional, "literals", literals);
        const unlinked = fieldOf(field, "unlinked") as readonly string[] | undefined;
        if (unlinked !== undefined) setFieldOn(optional, "unlinked", unlinked);
        fields.set(name, optional);
      }
    }
    const memberIndex = fieldOf(member, "index") as ResolvedType | null;
    if (memberIndex !== null) index = memberIndex;
  }
  return { kind: "record", fields, index, arms: [...arms] };
}

/**
 * The intersection of two records.
 *
 * A tag field on one side keeps the arms of the other that write a literal the
 * tag names: `DraftValue & { k: "buffer" | "sized" }` is the union of those two
 * arms, not the whole union. A record with no arms is the fields of both, which
 * is what an intersection of two plain records is.
 */
function intersectRecords(left: ResolvedType, right: ResolvedType): ResolvedType {
  const leftFields = fieldOf(left, "fields") as ReadonlyMap<string, ResolvedField>;
  const rightFields = fieldOf(right, "fields") as ReadonlyMap<string, ResolvedField>;
  const leftArms = fieldOf(left, "arms") as readonly ResolvedType[] | undefined;
  if (leftArms !== undefined) {
    let tagName: string | null = null;
    for (const [name, field] of rightFields) {
      if (literalsOf(field).length === 0) continue;
      tagName = name;
      break;
    }
    if (tagName !== null) {
      const allowed = literalsOf(rightFields.get(tagName));
      const kept: ResolvedType[] = [];
      for (const arm of leftArms) {
        if (String(fieldOf(arm, "kind")) !== "record") continue;
        const armFields = fieldOf(arm, "fields") as ReadonlyMap<string, ResolvedField>;
        const literals = literalsOf(armFields.get(tagName));
        let matches = false;
        for (const literal of literals) if (allowed.includes(literal)) matches = true;
        if (matches) kept[kept.length] = arm;
      }
      if (kept.length > 0) {
        const widened: ResolvedType[] = [];
        for (const arm of kept) {
          if (String(fieldOf(arm, "kind")) !== "record") {
            widened[widened.length] = arm;
            continue;
          }
          widened[widened.length] = {
            kind: "record",
            fields: withFields(fieldOf(arm, "fields") as ReadonlyMap<string, ResolvedField>, rightFields),
            index: fieldOf(arm, "index") as ResolvedType | null,
            arms: copyArms(fieldOf(arm, "arms") as readonly ResolvedType[] | undefined),
          };
        }
        return unionOfArms(widened);
      }
    }
    const fields = withFields(leftFields, rightFields);
    const arms: ResolvedType[] = [];
    for (const arm of leftArms) {
      if (String(fieldOf(arm, "kind")) !== "record") {
        arms[arms.length] = arm;
        continue;
      }
      arms[arms.length] = {
        kind: "record",
        fields: withFields(fieldOf(arm, "fields") as ReadonlyMap<string, ResolvedField>, rightFields),
        index: fieldOf(arm, "index") as ResolvedType | null,
        arms: copyArms(fieldOf(arm, "arms") as readonly ResolvedType[] | undefined),
      };
    }
    return { kind: "record", fields, index: fieldOf(left, "index") as ResolvedType | null, arms };
  }
  return { kind: "record", fields: withFields(leftFields, rightFields), index: (fieldOf(left, "index") as ResolvedType | null) ?? (fieldOf(right, "index") as ResolvedType | null) };
}

/** What an index read of a type answers, or null where the type names none. */
export function elementOfType(table: TypeTable, base: ResolvedType): ResolvedType | null {
  const baseKind = String(fieldOf(base, "kind"));
  if (baseKind === "list") return fieldOf(base, "of") as ResolvedType;
  if (baseKind === "record") {
    const recordIndex = fieldOf(base, "index") as ResolvedType | null;
    if (recordIndex !== null) return recordIndex;
  }
  const refName = fieldOf(base, "name") as string | null;
  if (baseKind === "ref" && refName !== null) {
    const decl = typeDeclared(table, refName);
    if (decl !== undefined) {
      const resolved = instantiate(decl, [], new Set(), table);
      const resolvedIndex = fieldOf(resolved, "index") as ResolvedType | null;
      if (String(fieldOf(resolved, "kind")) === "record" && resolvedIndex !== null) return resolvedIndex;
    }
  }
  return null;
}

/** The `Map` or `Set` a type names, or null where it names neither. */
export function collectionOfType(type: ResolvedType): { kind: "map"; key: ResolvedType; value: ResolvedType } | { kind: "set"; of: ResolvedType } | null {
  const kind = String(fieldOf(type, "kind"));
  if (kind === "map") return { kind: "map", key: fieldOf(type, "key") as ResolvedType, value: fieldOf(type, "value") as ResolvedType };
  if (kind === "set") return { kind: "set", of: fieldOf(type, "of") as ResolvedType };
  return null;
}

/**
 * What one field of a record holds, which is what `T["field"]` names.
 *
 * A name is read as the declaration it stands for first, because that is where
 * the field is written. A declaration the table does not hold, and a field it
 * does not write, name nothing this read can say: both are `any`. `T` may also
 * be a list or a collection, and every index of one of those is an element.
 */
function indexedFieldOf(table: TypeTable, type: ResolvedType, field: string): ResolvedType {
  const found = fieldOfType(table, type, field);
  if (found !== null) return fieldOf(found, "type") as ResolvedType;
  const kind = String(fieldOf(type, "kind"));
  if (kind === "list" || kind === "map" || kind === "set") return elementOfType(table, type) ?? ANY_TYPE;
  return ANY_TYPE;
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
    // A union laid out one member per line may lead with the bar the first
    // member is written after:
    //
    //     type Value =
    //       | { k: "a"; left: number }
    //       | { k: "b"; operand: number };
    //
    // The bar states no member, and reading it as one made the first member
    // `any` — which erased the whole union, because a union of anything but
    // records is the one member the value model can hold.
    this.space();
    this.take("|");
    const members = [this.intersection()];
    while (this.take("|")) members.push(this.intersection());
    if (members.length === 1) return members[0] as ResolvedType;
    // A union written as names — `type Value = Left | Right` where both are
    // interfaces — is the same union of records as the one written out member by
    // member, and each name is resolved where it stands. Without that the first
    // name was the whole union: a field only another member writes was a field
    // of nothing, and the arm a value is could not be named.
    const named = members.map((member) => this.resolveNamedMember(member));
    const present = named.filter((member) => String(fieldOf(member, "kind")) !== "absent");
    if (present.length === 0) return { kind: "absent" };
    if (present.length === 1) return present[0] as ResolvedType;
    // A union of records names the fields both write; a union that mixes
    // records with members of another kind keeps the records' fields and
    // every member as an arm, so a value the union holds can still be asked
    // for a field only one arm writes and the arm it is can still be named.
    // A union of members of no record is a value the read does not hold: a
    // text and a list are both references, and which one a value is is what a
    // `typeof` guard asks at run time. Reading it as the first member made a
    // list method a method of a text; the value is left untyped so the method
    // is deferred and a guard is what names the member it holds.
    if (present.some((member) => String(fieldOf(member, "kind")) === "record")) {
      const fields = new Map<string, ResolvedField>();
      let index: ResolvedType | null = null;
      for (const member of present) {
        if (String(fieldOf(member, "kind")) !== "record") continue;
        for (const [name, field] of fieldOf(member, "fields") as ReadonlyMap<string, { readonly type: ResolvedType }>) {
          if (!fields.has(name)) fields.set(name, { type: fieldOf(field, "type") as ResolvedType, optional: true });
        }
        const memberIndex = fieldOf(member, "index") as ResolvedType | null;
        if (memberIndex !== null) index = memberIndex;
      }
      return { kind: "record", fields, index, arms: present };
    }
    const mixed = present.some((member) => String(fieldOf(member, "kind")) === "list") && present.some((member) => String(fieldOf(member, "kind")) !== "list");
    if (mixed) return ANY_TYPE;
    return present[0] as ResolvedType;
  }

  /**
   * A member of a union that is written as a name, resolved to the record the
   * name declares.
   *
   * A name that states no record — a primitive alias, a collection — is the
   * member it was, and a name this table does not hold is left for the link.
   */
  private resolveNamedMember(member: ResolvedType): ResolvedType {
    const name = fieldOf(member, "name") as string | null;
    if (String(fieldOf(member, "kind")) !== "ref" || name === null) return member;
    const decl = typeDeclared(this.table, name);
    if (decl === undefined || this.seen.has(decl)) return member;
    const resolved = instantiate(decl, [], this.seen, this.table);
    return String(fieldOf(resolved, "kind")) === "record" ? resolved : member;
  }

  /** What one parameter of a function type holds, from the text it is written. */
  private parameterType(text: string): ResolvedType {
    const written = text.trim();
    const colon = written.indexOf(":");
    if (colon < 0) return ANY_TYPE;
    const type = written.slice(colon + 1).trim();
    if (type === "") return ANY_TYPE;
    try {
      return resolveTypeText(this.table, type, this.params, this.seen);
    } catch {
      return ANY_TYPE;
    }
  }

  private intersection(): ResolvedType {
    let type = this.postfix();
    while (this.take("&")) {
      const right = this.postfix();
      // A name stands for the record it declares: `DraftValue & { k: "view" }`
      // is the union DraftValue with the arms the tag names, which is what a
      // field only those arms write is read through.
      const left = this.resolveNamedMember(type);
      const other = this.resolveNamedMember(right);
      if (String(fieldOf(left, "kind")) === "record" && String(fieldOf(other, "kind")) === "record") {
        type = intersectRecords(left, other);
      } else if (String(fieldOf(left, "kind")) === "any") {
        type = other;
      } else {
        type = left;
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
      else if (this.text.slice(this.at, this.at + 1) === '"' || this.text.slice(this.at, this.at + 1) === "'" || this.text.slice(this.at, this.at + 1) === "`") {
        // `T["field"]` is what the field holds: the declaration the name stands
        // for is read first, because the field is written on it and not on the
        // name.
        const open = this.at;
        this.stringLiteral();
        const field = this.text.slice(open + 1, this.at - 1);
        this.space();
        this.take("]");
        type = indexedFieldOf(this.table, type, field);
      } else {
        // A tuple of two values whose first is a text — `readonly [string, V]`
        // is the entry a map or `Object.entries` reports — is the pair record
        // `first`/`second`. The key and the value are thereby read at their own
        // types, which a list of one element type cannot do.
        const first = this.union();
        const members = [first];
        while (this.take(",")) members.push(this.union());
        this.take("]");
        if (members.length === 2 && String(fieldOf(first, "kind")) === "text") {
          const fields = new Map<string, ResolvedField>([
            ["first", { type: first, optional: false }],
            ["second", { type: members[1] as ResolvedType, optional: false }],
          ]);
          type = { kind: "record", fields, index: null, tuple: true };
        } else {
          type = { kind: "list", of: first };
        }
      }
    }
  }

  private primary(): ResolvedType {
    this.space();
    if (this.at >= this.text.length) return ANY_TYPE;
    // `readonly T[]` is the list `T[]` is.
    if (this.word("readonly")) return this.postfix();
    if (this.text.slice(this.at, this.at + 1) === "(") {
      const close = this.findBalanced(this.at, "(", ")");
      const inner = close < 0 ? "" : this.text.slice(this.at + 1, close);
      this.at = close < 0 ? this.text.length : close + 1;
      this.space();
      if (this.take("=>")) {
        // A function type states its parameters, and a call through a value
        // held at one is written against them: `(text: string) => void` takes a
        // text, which is what an argument is read at.
        return {
          kind: "function",
          params: this.splitMembers(inner).map((one) => this.parameterType(one)),
          returns: this.union(),
        };
      }
      return inner.trim() === "" ? ANY_TYPE : resolveTypeText(this.table, inner, this.params, this.seen);
    }
    if (this.text.slice(this.at, this.at + 1) === "{") {
      const close = this.findBalanced(this.at, "{", "}");
      if (close < 0) return ANY_TYPE;
      const inner = this.text.slice(this.at + 1, close);
      this.at = close + 1;
      return this.record(inner);
    }
    if (this.text.slice(this.at, this.at + 1) === "[") {
      const save = this.at;
      this.skipBalanced("[", "]");
      // A tuple text only reaches here when the postfix reader did not see it;
      // the first member is what the index answers.
      this.at = save + 1;
      if (this.take("]")) return { kind: "list", of: ANY_TYPE };
      const first = this.union();
      const members = [first];
      while (this.take(",")) members.push(this.union());
      this.take("]");
      // A tuple whose first value is a text is the pair record `first`/`second`
      // the entry of a map or `Object.entries` is.
      if (members.length === 2 && String(fieldOf(first, "kind")) === "text") {
        return {
          kind: "record",
          fields: new Map<string, ResolvedField>([
            ["first", { type: first, optional: false }],
            ["second", { type: members[1] as ResolvedType, optional: false }],
          ]),
          index: null,
          tuple: true,
        };
      }
      return { kind: "list", of: first };
    }
    if (this.text.slice(this.at, this.at + 1) === "'" || this.text.slice(this.at, this.at + 1) === '"' || this.text.slice(this.at, this.at + 1) === "`") {
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
    // `Omit<T, "k">` and `Pick<T, "k">` are the record they name with fields
    // left out or kept. The keys are written as string literals, so they are
    // read from the text of the argument list rather than through the type
    // reader, which keeps a string literal as the text it is.
    if ((lower === "Omit" || lower === "Pick") && this.text.slice(this.at, this.at + 1) === "<") {
      const close = this.findBalanced(this.at, "<", ">");
      if (close < 0) {
        this.at += 1;
        return ANY_TYPE;
      }
      const parts = this.splitMembers(this.text.slice(this.at + 1, close));
      this.at = close + 1;
      const base = resolveTypeText(this.table, parts[0] ?? "", this.params, this.seen);
      const keys = new Set<string>();
      for (const part of parts.slice(1)) {
        for (const piece of part.split("|")) {
          const key = piece.trim().replace(/^['"`]/, "").replace(/['"`]$/, "");
          if (key !== "") keys.add(key);
        }
      }
      if (String(fieldOf(base, "kind")) !== "record") return base;
      const fields = new Map<string, ResolvedField>();
      for (const [name, field] of fieldOf(base, "fields") as ReadonlyMap<string, ResolvedField>) {
        if (lower === "Omit" ? !keys.has(name) : keys.has(name)) fields.set(name, field);
      }
      return { kind: "record", fields, index: fieldOf(base, "index") as ResolvedType | null };
    }
    const args = this.arguments();
    const first = args[0] ?? ANY_TYPE;
    switch (lower) {
      case "Array":
      case "ReadonlyArray":
      // `Iterable<T>` is what a program walks, and a list is the only thing
      // this subset walks: the element the type names is what the loop or the
      // spread written over it holds.
      case "Iterable":
      case "ArrayLike":
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
      // `Extract<T, U>` is the members of `T` that `U` names, and `Exclude<T, U>`
      // is the ones it does not. The type reader keeps a union of records as one
      // record with the fields every member writes and the others beside them as
      // optional, and it keeps no literal text: the member a discriminant names
      // is not a distinction it can make. The whole of `T` is therefore what is
      // read. It is the wider type of the two, so a field only the member
      // `Extract` keeps writes is still one the layout that writes it answers,
      // and a read of a field two members write at different types is refused
      // by the layouts rather than guessed.
      case "Extract":
      case "Exclude":
        return first;
      case "Record":
        return { kind: "record", fields: new Map(), index: args[1] ?? ANY_TYPE };
      case "Function":
        return { kind: "function", params: [], returns: ANY_TYPE };
    }
    const param = this.params.get(lower);
    if (param !== undefined) return param;
    const decl = typeDeclared(this.table, lower);
    if (decl !== undefined) return instantiate(decl, args, this.seen, this.table);
    if ((fieldOf(this.table, "classes") as Map<string, unknown>).has(lower)) return { kind: "ref", name: lower };
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
      let name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(trimmed);
      if (name === null) continue;
      let rest = trimmed.slice(name[0].length).trim();
      // A member may be written with a modifier in front of its name, as every
      // field of the IR's own records is: `readonly applied: SemanticFunction`.
      // The modifier states what a body may write, not what the field is, and
      // reading it as the name dropped the field the name belongs to.
      if (RECORD_MODIFIERS.has(name[0]) && !rest.startsWith(":")) {
        const named = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
        if (named !== null) {
          name = named;
          rest = rest.slice(named[0].length).trim();
        }
      }
      const optional = rest.startsWith("?");
      if (optional) rest = rest.slice(1).trim();
      // A member written as a method is a field held at a function type: an
      // object type inside a field — `Module: { exports(...): ... }` — names
      // the methods a value of it answers, and a call of one is the call of
      // the function the field holds.
      if (rest.startsWith("(") || rest.startsWith("<")) {
        let scan = rest;
        if (scan.startsWith("<")) {
          let angles = 0;
          let at = 0;
          for (; at < scan.length; at += 1) {
            if (scan.slice(at, at + 1) === "<") angles += 1;
            else if (scan.slice(at, at + 1) === ">") {
              angles -= 1;
              if (angles === 0) break;
            }
          }
          if (angles !== 0) continue;
          scan = scan.slice(at + 1).trim();
        }
        if (!scan.startsWith("(")) continue;
        let depth = 0;
        let at = 0;
        for (; at < scan.length; at += 1) {
          if (scan.slice(at, at + 1) === "(") depth += 1;
          else if (scan.slice(at, at + 1) === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) continue;
        const params = scan.slice(0, at + 1);
        const after = scan.slice(at + 1).trim();
        const returns = after.startsWith(":") ? after.slice(1).trim() : "void";
        fields.set(name[0], {
          type: resolveTypeText(this.table, `${params} => ${returns}`, this.params, this.seen),
          optional,
        });
        continue;
      }
      if (!rest.startsWith(":")) continue;
      const type = rest.slice(1).trim();
      const literals = this.fieldLiterals(type);
      fields.set(name[0], {
        type: resolveTypeText(this.table, type, this.params, this.seen),
        optional,
        ...(literals === null ? {} : {
          literal: literals.length === 1 ? literals[0] as string : undefined,
          literals,
        }),
      });
    }
    return { kind: "record", fields, index };
  }

  /** The literals a field annotation writes, where every member is one. */
  private fieldLiterals(text: string): string[] | null {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text.slice(index, index + 1);
      if (quote !== "") {
        if (char === quote && text.slice(index - 1, index) !== "\\") quote = "";
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{" || char === "(" || char === "[" || char === "<") depth += 1;
      else if (char === "}" || char === ")" || char === "]" || char === ">") depth -= 1;
      else if (char === "|" && depth === 0) {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(text.slice(start));
    const literals = parts.map((part) => this.fieldLiteral(part.trim()));
    if (literals.some((one) => one === null)) return null;
    return literals as string[];
  }

  /** The text a field annotation writes, where it writes one literal. */
  private fieldLiteral(text: string): string | null {
    const written = text.trim();
    if (written.length >= 2 && /^['"`]/.test(written) && /['"`]$/.test(written)) {
      return written.slice(1, -1);
    }
    if (/^-?\d+(?:\.\d+)?$/.test(written)) return written;
    return null;
  }

  /** The `;`-separated members of an object type, at brace depth zero. */
  private splitMembers(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text.slice(index, index + 1);
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
    while (this.at < this.text.length && /[A-Za-z0-9_$.]/.test(this.text.slice(this.at, this.at + 1) as string)) this.at += 1;
    if (this.at === start) return null;
    return this.text.slice(start, this.at);
  }

  private word(word: string): boolean {
    this.space();
    if (!this.text.startsWith(word, this.at)) return false;
    const after = this.text.slice(this.at + word.length, this.at + word.length + 1);
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) return false;
    this.at += word.length;
    return true;
  }

  private stringLiteral(): void {
    const quote = this.text.slice(this.at, this.at + 1) as string;
    this.at += 1;
    while (this.at < this.text.length) {
      const char = this.text.slice(this.at, this.at + 1) as string;
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
      const char = this.text.slice(index, index + 1) as string;
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  private space(): void {
    while (this.at < this.text.length && /\s/.test(this.text.slice(this.at, this.at + 1) as string)) this.at += 1;
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
  return resolveTypeText(table, typeText(tokens, from, to), new Map(), new Set());
}

/** Resolves an annotation already written as one text, as a class field is. */
/**
 * The `T` a type text writes as `Promise<T>`, or null where it writes no
 * promise.
 *
 * A method's declared result is a text the class scan kept, and an async
 * method's promise is the value its caller's `await` holds: the payload is what
 * the method answers, as an async function's annotation states it.
 */
export function promisePayloadText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("Promise<") || !trimmed.endsWith(">")) return null;
  return trimmed.slice("Promise<".length, -1).trim();
}

export function resolveTypeName(table: TypeTable, typeName: string): ResolvedType {
  return resolveTypeText(table, typeName, new Map(), new Set());
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
): boolean {
  const store = expansionsOf(table);
  setFieldOn(store, "generation", Number(fieldOf(store, "generation")) + 1);
  let added = false;
  for (const entry of imports) {
    const target = targets.get(String(fieldOf(entry, "specifier")));
    if (target === undefined) continue;
    const exported = fieldOf(target, "exported") as Map<string, TypeDecl>;
    const declarations = fieldOf(target, "declarations") as Map<string, TypeDecl>;
    const reexported = fieldOf(target, "reexported") as Set<string>;
    const imported = fieldOf(target, "imported") as Map<string, TypeDecl>;
    const ownImported = fieldOf(table, "imported") as Map<string, TypeDecl>;
    for (const name of fieldOf(entry, "names") as readonly { readonly local: string; readonly imported: string }[]) {
      const local = String(fieldOf(name, "local"));
      const importedName = String(fieldOf(name, "imported"));
      let decl = exported.get(importedName) ?? declarations.get(importedName);
      // A module that re-exports a type writes no declaration for it: the
      // name stands for the declaration its own import bound, which the graph
      // binds before this file when the two are linked more than once.
      if (decl === undefined && reexported.has(importedName)) decl = imported.get(importedName);
      if (decl === undefined) continue;
      if (ownImported.get(local) === decl) continue;
      ownImported.set(local, decl);
      added = true;
    }
  }
  return added;
}

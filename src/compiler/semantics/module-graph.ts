/**
 * The module graph: every source of a program, read by the frontend, with every
 * import resolved and every file read again with what its imports bind.
 *
 * A file may name a declaration another file writes, so reading is two passes:
 * the first learns the imports, and the second reads each file with the types,
 * values and signatures those imports bind. The contract phase builds its
 * contracts from this graph, and a measurement of a tree reads the same graph so
 * its queue counts the constructs that survive a link rather than the ones that
 * are only waiting for one.
 *
 * A build reads strictly, but the verdict is the linked read's: a frontend that
 * answers its refusals lets the graph keep the first analysis, and the file is
 * refused after the second read when the link did not settle it. A measurement
 * supplies its own `reader` and counts the refusals itself, so one refused file
 * does not hide every file that imports it and no error is thrown here.
 */

import { dirname, extname, join, normalize } from "../core/platform.ts";
import { CompilerError } from "../core/errors.ts";
import type { SourceModule, TypeExpr } from "../core/types.ts";
import { refusalError, type Diagnostic } from "./diagnostics.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport, ModuleTypeImport } from "./module.ts";
import type { ImportedFunction } from "./typescript.ts";
import { bindImportedClasses } from "./typescript-classes.ts";
import type { ClassInfo, ClassMethod, ClassTable } from "./typescript-classes.ts";
import { bindImportedTypes, promisePayloadText, resolveTypeName } from "./typescript-types.ts";
import type { ResolvedType, TypeTable } from "./typescript-types.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** An error of the contract phase, which is where the graph is read. */
export function contractPhaseError(message: string, detail?: string): CompilerError {
  return new CompilerError("ContractError", "contract", message, detail, "", "", "");
}

/** The path a source given inline to a project file is known by. */
export const INLINE_MODULE = "<inline>";

/** One file of the program, with where each of its imports landed. */
export interface ModuleRecord {
  path: string;
  source: string;
  analysis: ModuleAnalysis;
  /** Resolved import targets, in the order the imports are written. */
  resolved: string[];
  /** Resolved type imports, in the order `analysis.typeImports` writes them. */
  typeResolved: string[];
  /** The constructs the last read refused, or nothing when it read the file whole. */
  refused: readonly Diagnostic[];
  /** How many the last read refused, including the ones it did not list. */
  refusedCount: number;
}

/** What one read of a module answers: its analysis, and what it refused. */
export interface ModuleRead {
  analysis: ModuleAnalysis;
  refused: readonly Diagnostic[];
  count: number;
}

/** How one module is read. */
export type ModuleReader = (source: string, path: string, entry: boolean, context?: unknown) => ModuleRead;

export interface ModuleGraphRequest {
  frontend: Frontend;
  /** The entry module, with the path the project knows it by. */
  entry: SourceModule;
  /**
   * Files the graph reads beside the ones the entry reaches.
   *
   * A build reads the entry and whatever its imports reach. A measurement of a
   * tree reads every file of the tree, including the ones no import reaches, so
   * its queue names the gaps of the whole tree rather than of one binary's
   * closure.
   */
  roots?: readonly string[];
  /** Reads an imported module by project-relative path; null when there is none. */
  read: (path: string) => string | null;
  /**
   * Whether an import that names no file of the project refuses the graph.
   *
   * A build refuses one: a program cannot run a module it does not hold. A
   * measurement of a tree reads files that name a package the tree does not
   * hold — the platform boundary and the model client name theirs — and asks
   * what the frontend can read of them. The import is then left unbound rather
   * than refusing a file whose text the frontend may still read whole.
   */
  requireImports?: boolean;
  /**
   * Reads one module. Defaults to the frontend's own read, which stops at the
   * first file it refuses; a measurement supplies one that answers the refusal
   * so the rest of the tree is still read.
   */
  reader?: ModuleReader;
  /**
   * Whether a bare specifier names an installed package.
   *
   * A build reads one: the compiler's own tree imports `smol-toml`, and a
   * binary that cannot read the package cannot be built from the tree that
   * names it. A measurement of the compiler's sources asks what the frontend
   * reads of those sources, and a package the tree installs would be counted
   * as part of the tree's own gaps.
   */
  resolvePackages?: boolean;
  /**
   * A module a project replaces, by the path a source imports.
   *
   * A project may map a host specifier to a file of its own; the file is read
   * under the name the source imports, so a file that names `#host/platform`
   * is read as the adapter the project selected.
   */
  host?: Readonly<Record<string, string>>;
  /**
   * The project file each host specifier names, by specifier.
   *
   * A `#`-prefixed import is the host boundary unless the project maps it to a
   * file of its own: the map is how one tree selects the Node platform adapter
   * or the native one without a branch in the sources.
   */
  modules?: Readonly<Record<string, string>>;
}

/** The values every module of the program offers, in discovery order. */
export interface OfferedValues {
  path: string;
  values: Map<string, unknown>;
  /** The type each offered declaration writes, where its value is not one the
   *  file wrote out. */
  shapes: Map<string, unknown>;
}

/** The values every module of the program offers, in discovery order. */
export function offeredValues(records: readonly ModuleRecord[]): OfferedValues[] {
  const offered: OfferedValues[] = [];
  const byPath = new Map<string, OfferedValues>();
  for (const record of records) {
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    const values = fieldOf(analysis, "constants") as ReadonlyMap<string, unknown> | undefined;
    const shapes = fieldOf(analysis, "valueShapes") as ReadonlyMap<string, unknown> | undefined;
    const path = String(fieldOf(record, "path"));
    const entry: OfferedValues = { path, values: new Map(values ?? []), shapes: new Map(shapes ?? []) };
    offered.push(entry);
    byPath.set(path, entry);
  }
  // A module that re-exports a value offers what the module that declares it
  // offers: `export { host } from "#host/platform"` is the value, under the
  // name this module writes. The bind runs until no module gains a name, so a
  // re-export of a re-export crosses as well.
  let linked = true;
  while (linked) {
    linked = false;
    for (const record of records) {
      const own = byPath.get(String(fieldOf(record, "path")));
      if (own === undefined) continue;
      const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
      const imports = fieldOf(analysis, "imports") as readonly ModuleImport[];
      const resolved = fieldOf(record, "resolved") as readonly string[];
      const reexports = fieldOf(analysis, "reexports") as readonly { readonly specifier: string; readonly names: readonly string[]; readonly renames?: readonly { readonly local: string; readonly exported: string }[] }[] | undefined;
      for (const entry of reexports ?? []) {
        let index = -1;
        for (let at = 0; at < imports.length; at += 1) {
          if (String(fieldOf(imports[at], "specifier")) === String(fieldOf(entry, "specifier"))) index = at;
        }
        if (index < 0) continue;
        const target = byPath.get(resolved[index] ?? "");
        if (target === undefined) continue;
        for (const name of fieldOf(entry, "names") as readonly string[]) {
          let exported = name;
          const renames = fieldOf(entry, "renames") as readonly { readonly local: string; readonly exported: string }[] | undefined;
          for (const renamed of renames ?? []) {
            if (String(fieldOf(renamed, "local")) === String(name)) exported = String(fieldOf(renamed, "exported"));
          }
          const targetValues = fieldOf(target, "values") as Map<string, unknown>;
          const targetShapes = fieldOf(target, "shapes") as Map<string, unknown>;
          const ownValues = fieldOf(own, "values") as Map<string, unknown>;
          const ownShapes = fieldOf(own, "shapes") as Map<string, unknown>;
          const value = targetValues.get(name);
          if (value !== undefined && !ownValues.has(exported)) {
            ownValues.set(exported, value);
            linked = true;
          }
          const shape = targetShapes.get(name);
          if (shape !== undefined && !ownShapes.has(exported)) {
            ownShapes.set(exported, shape);
            linked = true;
          }
        }
      }
    }
  }
  return offered.filter((one) => (fieldOf(one, "values") as Map<string, unknown>).size > 0 || (fieldOf(one, "shapes") as Map<string, unknown>).size > 0);
}

/** The names a contract type names, which are the declarations it links. */
function linkedTypeNames(type: TypeExpr, into: Set<string>): void {
  if (type.kind === "ref") {
    const name = fieldOf(type, "name");
    if (typeof name === "string") into.add(name);
    const of = fieldOf(type, "of") as TypeExpr | null;
    if (of !== null) linkedTypeNames(of, into);
    return;
  }
  if (type.kind === "ptr" || type.kind === "slice" || type.kind === "array") {
    linkedTypeNames(fieldOf(type, "of") as TypeExpr, into);
  }
}

/** The names a value's shape names, which are the declarations it links. */
function linkedShapeNames(shape: ResolvedType, into: Set<string>): void {
  if (shape.kind === "ref") {
    const name = fieldOf(shape, "name") as string | null;
    if (name !== null) into.add(name);
    return;
  }
  if (shape.kind === "list" || shape.kind === "set") {
    linkedShapeNames(fieldOf(shape, "of") as ResolvedType, into);
    return;
  }
  if (shape.kind === "map") {
    linkedShapeNames(fieldOf(shape, "key") as ResolvedType, into);
    linkedShapeNames(fieldOf(shape, "value") as ResolvedType, into);
    return;
  }
  if (shape.kind === "record") {
    for (const field of (fieldOf(shape, "fields") as ReadonlyMap<string, { readonly type: ResolvedType }>).values()) linkedShapeNames(fieldOf(field, "type") as ResolvedType, into);
    const index = fieldOf(shape, "index") as ResolvedType | null;
    if (index !== null) linkedShapeNames(index, into);
    return;
  }
  if (shape.kind === "function") {
    for (const param of fieldOf(shape, "params") as readonly ResolvedType[]) linkedShapeNames(param, into);
    linkedShapeNames(fieldOf(shape, "returns") as ResolvedType, into);
  }
}

/**
 * Binds the declarations a linked signature or value names.
 *
 * A function's contract states its parameters and result as types, and a
 * value's shape is a record of fields: a name in either is a declaration the
 * exporting module wrote, or one a re-export reached. The importing file is
 * read against those declarations, so a method of a class another module
 * answers is a method there. The declaration is searched for in the program's
 * modules rather than only in the file the import names, because a re-export
 * offers another module's declaration under its own name.
 */
/** The names a written type text names, which are the declarations it links. */
function linkedNamesInText(text: string, into: Set<string>): void {
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = match[0];
    if (name === "ref" || name === "ptr" || name === "slice" || name === "array" || name === "boxedtext") continue;
    if (name === "f32" || name === "f64" || name === "u8" || name === "u16" || name === "u32" || name === "u64") continue;
    if (name === "i8" || name === "i16" || name === "i32" || name === "i64" || name === "usize" || name === "isize") continue;
    if (name === "bool" || name === "text" || name === "void" || name === "any") continue;
    into.add(name);
  }
}

function bindLinkedDeclarations(
  record: ModuleRecord,
  names: ReadonlySet<string>,
  records: ReadonlyMap<string, ModuleRecord>,
): void {
  const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
  const ownTypes = fieldOf(analysis, "types") as TypeTable | undefined;
  const ownClasses = fieldOf(analysis, "classes") as ClassTable | undefined;
  // A declaration names other declarations: an interface's fields, a base it
  // extends, an alias's target, a class's fields and methods. A value of the
  // interface read in this file needs those names too, because a field is read
  // through the type the declaration gives it. The work list is the names the
  // linked types name, expanded until it names nothing new.
  const pending = [...names];
  const seen = new Set<string>(pending);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    const declarations = ownTypes === undefined ? new Map<string, unknown>() : fieldOf(ownTypes, "declarations") as Map<string, unknown>;
    const imported = ownTypes === undefined ? new Map<string, unknown>() : fieldOf(ownTypes, "imported") as Map<string, unknown>;
    if (ownTypes !== undefined && !declarations.has(name) && !imported.has(name)) {
      for (const source of records.values()) {
        const types = fieldOf(fieldOf(source, "analysis"), "types") as TypeTable | undefined;
        if (types === undefined) continue;
        const sourceDeclarations = fieldOf(types, "declarations") as Map<string, unknown>;
        const sourceExported = fieldOf(types, "exported") as Map<string, unknown>;
        const sourceImported = fieldOf(types, "imported") as Map<string, unknown>;
        const declared = sourceDeclarations.get(name) ?? sourceExported.get(name) ?? sourceImported.get(name);
        if (declared === undefined) continue;
        imported.set(name, declared);
        const named = new Set<string>();
        for (const field of (fieldOf(declared, "fields") as ReadonlyMap<string, { readonly typeName: string }>).values()) linkedNamesInText(String(fieldOf(field, "typeName")), named);
        for (const base of fieldOf(declared, "extends") as readonly string[]) linkedNamesInText(base, named);
        const targetText = fieldOf(declared, "target") as string | null;
        if (targetText !== null) linkedNamesInText(targetText, named);
        for (const next of named) {
          if (seen.has(next)) continue;
          seen.add(next);
          pending.push(next);
        }
        break;
      }
    }
    const classNames = ownClasses === undefined ? new Set<string>() : fieldOf(ownClasses, "names") as Set<string>;
    if (ownClasses !== undefined && !classNames.has(name)) {
      for (const source of records.values()) {
        const offered = classOffered(source, name, records, new Set());
        if (offered === undefined) continue;
        classNames.add(name);
        (fieldOf(ownClasses, "classes") as Map<string, unknown>).set(name, offered);
        const named = new Set<string>();
        for (const field of fieldOf(offered, "fields") as readonly { readonly typeName: string }[]) linkedNamesInText(String(fieldOf(field, "typeName")), named);
        const callables: { readonly typeName: string; readonly returnTypeName: string; readonly params: readonly { readonly typeName: string }[] }[] = [];
        for (const one of fieldOf(offered, "methods") as readonly { readonly typeName: string; readonly returnTypeName: string; readonly params: readonly { readonly typeName: string }[] }[]) callables[callables.length] = one;
        for (const one of fieldOf(offered, "getters") as readonly { readonly typeName: string; readonly returnTypeName: string; readonly params: readonly { readonly typeName: string }[] }[]) callables[callables.length] = one;
        for (const method of callables) {
          linkedNamesInText(String(fieldOf(method, "returnTypeName")), named);
          for (const param of fieldOf(method, "params") as readonly { readonly typeName: string }[]) linkedNamesInText(String(fieldOf(param, "typeName")), named);
        }
        for (const next of named) {
          if (seen.has(next)) continue;
          seen.add(next);
          pending.push(next);
        }
        break;
      }
    }
  }
}

/**
 * The signatures of the functions another module declares, by the names this
 * file imports them under.
 *
 * A runtime import binds a name: the function is compiled in the module that
 * writes it, and a call here answers what that function declares. The graph has
 * already read the module, so the signature is the one its analysis kept.
 */
/**
 * The getter a module's value is read through, following a re-export.
 *
 * A module that re-exports a value names a getter the other module wrote:
 * `export { host } from "#host/platform"` offers `host` only as the getter in
 * the adapter, so the search crosses each re-export to the module that holds
 * the value.
 */
function valueGetterOf(
  record: ModuleRecord,
  name: string,
  records: ReadonlyMap<string, ModuleRecord>,
  seen: Set<string>,
): { path: string; name: string } | undefined {
  const recordPath = String(fieldOf(record, "path"));
  if (seen.has(recordPath)) return undefined;
  seen.add(recordPath);
  const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
  const getters = fieldOf(analysis, "valueGetters") as Map<string, string> | undefined;
  const direct = getters?.get(name);
  if (direct !== undefined) return { path: recordPath, name: direct };
  const imports = fieldOf(analysis, "imports") as readonly ModuleImport[];
  const resolved = fieldOf(record, "resolved") as readonly string[];
  const reexports = fieldOf(analysis, "reexports") as readonly { readonly specifier: string; readonly names: readonly string[]; readonly renames?: readonly { readonly local: string; readonly exported: string }[] }[] | undefined;
  for (const entry of reexports ?? []) {
    let wanted = name;
    for (const one of fieldOf(entry, "renames") as readonly { readonly local: string; readonly exported: string }[] | undefined ?? []) {
      if (String(fieldOf(one, "exported")) === name) wanted = String(fieldOf(one, "local"));
    }
    const names = fieldOf(entry, "names") as readonly string[];
    let listed = false;
    for (const one of names) if (String(one) === wanted) listed = true;
    if (!listed) continue;
    let index = -1;
    for (let at = 0; at < imports.length; at += 1) {
      if (String(fieldOf(imports[at], "specifier")) === String(fieldOf(entry, "specifier"))) index = at;
    }
    if (index < 0) continue;
    const target = records.get(resolved[index] ?? "");
    if (target === undefined) continue;
    const found = valueGetterOf(target, wanted, records, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function importedFunctionsOf(
  record: ModuleRecord,
  records: ReadonlyMap<string, ModuleRecord>,
): Map<string, ImportedFunction> {
  const functions = new Map<string, ImportedFunction>();
  const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
  const imports = fieldOf(analysis, "imports") as readonly ModuleImport[];
  const resolved = fieldOf(record, "resolved") as readonly string[];
  for (let index = 0; index < imports.length; index += 1) {
    const entry = imports[index];
    if (fieldOf(entry, "default") === true || fieldOf(entry, "names") === null) continue;
    const target = records.get(resolved[index] ?? "");
    if (target === undefined) continue;
    // A name the file imports under another name is seeded under the name this
    // file writes: a call is read against that name and emitted under the one
    // the other module exports.
    const named: { local: string; imported: string }[] = [];
    for (const name of fieldOf(entry, "names") as readonly string[]) named[named.length] = { local: String(name), imported: String(name) };
    for (const rename of fieldOf(entry, "renames") as readonly { readonly local: string; readonly imported: string }[] | undefined ?? []) named[named.length] = rename;
    for (const naming of named) {
      const local = String(fieldOf(naming, "local"));
      const imported = String(fieldOf(naming, "imported"));
      // A file whose body could not be held still offers the signatures of what
      // it exports: the declaration is refused where it is written, and the
      // calls a file writes to it are read against the parameters and result
      // the declaration states.
      const declared = declaredOffered(target, imported, records, new Set());
      if (declared === undefined) {
        // A value the exporting module holds is offered under the value's name
        // and read through the getter function the module wrote for it.
        const getterName = valueGetterOf(target, imported, records, new Set());
        let getter: DeclaredFunction | undefined;
        if (getterName !== undefined) {
          const getterRecord = records.get(String(fieldOf(getterName, "path")));
          if (getterRecord !== undefined) {
            const getterAnalysis = fieldOf(getterRecord, "analysis") as ModuleAnalysis;
            for (const entry of fieldOf(getterAnalysis, "functions") as readonly DeclaredFunction[]) {
              if (String(fieldOf(entry, "name")) === String(fieldOf(getterName, "name"))) getter = entry;
            }
          }
        }
        if (getter !== undefined) {
          const getterParams = fieldOf(getter, "params") as readonly { readonly type: TypeExpr }[];
          const params: TypeExpr[] = [];
          for (const param of getterParams) params[params.length] = fieldOf(param, "type") as TypeExpr;
          const signature: ImportedFunction = {
            params,
            returns: fieldOf(getter, "returns") as TypeExpr,
            valueGetter: true,
          };
          const linked = new Set<string>();
          for (const param of getterParams) linkedTypeNames(fieldOf(param, "type") as TypeExpr, linked);
          linkedTypeNames(fieldOf(getter, "returns") as TypeExpr, linked);
          bindLinkedDeclarations(record, linked, records);
          functions.set(local, signature);
        }
        continue;
      }
      const declaredParams = fieldOf(declared, "params") as readonly { readonly type: TypeExpr }[];
      const params: TypeExpr[] = [];
      for (const param of declaredParams) params[params.length] = fieldOf(param, "type") as TypeExpr;
      const signature: ImportedFunction = {
        params,
        returns: fieldOf(declared, "returns") as TypeExpr,
      };
      const handle = fieldOf(declared, "handle") as {
        readonly returnsShape?: ImportedFunction["shape"];
        readonly collection?: ImportedFunction["collection"];
        readonly params?: readonly { readonly shape?: ResolvedType | null }[];
        readonly async?: boolean;
      } | undefined;
      if (fieldOf(handle, "async") === true) signature.async = true;
      const returnsShape = fieldOf(handle, "returnsShape") as ImportedFunction["shape"] | undefined;
      if (returnsShape !== undefined) signature.shape = returnsShape;
      const collection = fieldOf(handle, "collection") as ImportedFunction["collection"] | undefined;
      if (collection !== undefined) signature.collection = collection;
      const handleParams = fieldOf(handle, "params") as readonly { readonly shape?: ResolvedType | null }[] | undefined;
      if (handleParams !== undefined) {
        const shapes: (ResolvedType | null)[] = [];
        for (const param of handleParams) shapes[shapes.length] = (fieldOf(param, "shape") as ResolvedType | undefined) ?? null;
        signature.paramShapes = shapes;
      }
      const linked = new Set<string>();
      for (const param of declaredParams) linkedTypeNames(fieldOf(param, "type") as TypeExpr, linked);
      linkedTypeNames(fieldOf(declared, "returns") as TypeExpr, linked);
      bindLinkedDeclarations(record, linked, records);
      functions.set(local, signature);
    }
  }
  return functions;
}

/**
 * The records to read again, each after the records it imports.
 *
 * A module is read again once the modules it imports have been, because what
 * it links is their analysis: a signature's result shape, a value's shape, a
 * class's description. A module a file imports from is written after it in the
 * answer, so a pass over this order reads the deepest module first. A circular
 * import names a module already being read, and the record is placed where the
 * cycle closes rather than read twice.
 */
function bindingOrder(records: ReadonlyMap<string, ModuleRecord>): ModuleRecord[] {
  const order: ModuleRecord[] = [];
  const seen = new Set<string>();
  for (const root of records.values()) {
    const stackRecords: ModuleRecord[] = [];
    const stackExpanded: boolean[] = [];
    stackRecords.push(root);
    stackExpanded.push(false);
    while (stackRecords.length > 0) {
      const current = stackRecords.pop() as ModuleRecord;
      const expanded = stackExpanded.pop() as boolean;
      const currentPath = String(fieldOf(current, "path"));
      if (expanded) {
        order.push(current);
        continue;
      }
      if (seen.has(currentPath)) continue;
      seen.add(currentPath);
      stackRecords.push(current);
      stackExpanded.push(true);
      const paths: string[] = [];
      for (const one of fieldOf(current, "resolved") as readonly string[]) paths[paths.length] = one;
      for (const one of fieldOf(current, "typeResolved") as readonly string[]) paths[paths.length] = one;
      for (let at = paths.length - 1; at >= 0; at -= 1) {
        const imported = records.get(paths[at]);
        if (imported !== undefined) {
          stackRecords.push(imported);
          stackExpanded.push(false);
        }
      }
    }
  }
  return order;
}

/**
 * The declaration a module offers under a name, following a re-export.
 *
 * `export { a } from "./x.ts"` offers a name the other module writes: this file
 * compiles nothing of it, and the signature a caller reads is the one the
 * module that declares the function wrote.
 */
function declaredOffered(
  record: ModuleRecord,
  name: string,
  records: ReadonlyMap<string, ModuleRecord>,
  seen: Set<string>,
): DeclaredFunction | undefined {
  const recordPath = String(fieldOf(record, "path"));
  if (seen.has(recordPath)) return undefined;
  seen.add(recordPath);
  const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
  const exportNames = fieldOf(analysis, "exportNames") as readonly { readonly local: string; readonly exported: string }[] | undefined;
  let renamed: { readonly local: string; readonly exported: string } | undefined;
  for (const one of exportNames ?? []) if (String(fieldOf(one, "exported")) === name) renamed = one;
  const local = renamed === undefined ? name : String(fieldOf(renamed, "local"));
  let held: DeclaredFunction | undefined;
  for (const one of fieldOf(analysis, "functions") as readonly DeclaredFunction[]) {
    if (String(fieldOf(one, "name")) !== local) continue;
    if (fieldOf(one, "exported") === true || renamed !== undefined) held = one;
  }
  if (held === undefined) {
    for (const one of (fieldOf(analysis, "signatures") as readonly DeclaredFunction[] | undefined) ?? []) {
      if (String(fieldOf(one, "name")) === local) held = one;
    }
  }
  if (held !== undefined) {
    if (renamed === undefined) return held;
    const copy: DeclaredFunction = {
      name,
      exported: fieldOf(held, "exported") === true,
      params: fieldOf(held, "params") as { name: string; type: TypeExpr }[],
      returns: fieldOf(held, "returns") as TypeExpr,
      handle: fieldOf(held, "handle"),
    };
    if (fieldOf(held, "internal") === true) copy.internal = true;
    return copy;
  }
  const imports = fieldOf(analysis, "imports") as readonly ModuleImport[];
  const resolved = fieldOf(record, "resolved") as readonly string[];
  const reexports = fieldOf(analysis, "reexports") as readonly { readonly specifier: string; readonly names: readonly string[]; readonly renames?: readonly { readonly local: string; readonly exported: string }[] }[] | undefined;
  for (const entry of reexports ?? []) {
    // A re-export may offer the other module's name under another name here.
    let wanted = name;
    for (const one of fieldOf(entry, "renames") as readonly { readonly local: string; readonly exported: string }[] | undefined ?? []) {
      if (String(fieldOf(one, "exported")) === name) wanted = String(fieldOf(one, "local"));
    }
    let listed = false;
    for (const one of fieldOf(entry, "names") as readonly string[]) if (String(one) === wanted) listed = true;
    if (!listed) continue;
    let index = -1;
    for (let at = 0; at < imports.length; at += 1) if (String(fieldOf(imports[at], "specifier")) === String(fieldOf(entry, "specifier"))) index = at;
    if (index < 0) continue;
    const target = records.get(resolved[index] ?? "");
    if (target === undefined) continue;
    const found = declaredOffered(target, wanted, records, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The class a module offers under a name, following a re-export.
 *
 * `export { Diagnostics } from "./diagnostics.ts"` offers a class the other
 * module declares: a file that imports the name from the re-exporting module
 * reads the fields and methods of the class the declaring module wrote, and the
 * description of it is the one there.
 */
function classOffered(
  record: ModuleRecord,
  name: string,
  records: ReadonlyMap<string, ModuleRecord>,
  seen: Set<string>,
): ClassInfo | undefined {
  const recordPath = String(fieldOf(record, "path"));
  if (seen.has(recordPath)) return undefined;
  seen.add(recordPath);
  const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
  const exportNames = fieldOf(analysis, "exportNames") as readonly { readonly local: string; readonly exported: string }[] | undefined;
  let renamed: { readonly local: string; readonly exported: string } | undefined;
  for (const one of exportNames ?? []) if (String(fieldOf(one, "exported")) === name) renamed = one;
  const local = renamed === undefined ? name : String(fieldOf(renamed, "local"));
  const classes = fieldOf(analysis, "classes") as ClassTable | undefined;
  const classMap = classes === undefined ? new Map<string, ClassInfo>() : fieldOf(classes, "classes") as Map<string, ClassInfo>;
  const held = classMap.get(local);
  if (held !== undefined) return withMethodShapes(held, record);
  const imports = fieldOf(analysis, "imports") as readonly ModuleImport[];
  const resolved = fieldOf(record, "resolved") as readonly string[];
  const reexports = fieldOf(analysis, "reexports") as readonly { readonly specifier: string; readonly names: readonly string[]; readonly renames?: readonly { readonly local: string; readonly exported: string }[] }[] | undefined;
  for (const entry of reexports ?? []) {
    let wanted = name;
    for (const one of fieldOf(entry, "renames") as readonly { readonly local: string; readonly exported: string }[] | undefined ?? []) {
      if (String(fieldOf(one, "exported")) === name) wanted = String(fieldOf(one, "local"));
    }
    let listed = false;
    for (const one of fieldOf(entry, "names") as readonly string[]) if (String(one) === wanted) listed = true;
    if (!listed) continue;
    let index = -1;
    for (let at = 0; at < imports.length; at += 1) if (String(fieldOf(imports[at], "specifier")) === String(fieldOf(entry, "specifier"))) index = at;
    if (index < 0) continue;
    const target = records.get(resolved[index] ?? "");
    if (target === undefined) continue;
    const found = classOffered(target, wanted, records, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The class a module declared, with what each method answers resolved against
 * the table the module wrote it in.
 *
 * A method's result type is a name in the declaring module, and the file that
 * calls the method may not import that name: `failure.toJSON()` answers
 * `SerializedCompilerError`, which `compiler.ts` never names. The shape is
 * resolved where the declaration is, and it crosses the link with the class.
 */
function withMethodShapes(info: ClassInfo, record: ModuleRecord): ClassInfo {
  const types = fieldOf(fieldOf(record, "analysis"), "types") as TypeTable | undefined;
  if (types === undefined) return info;
  const shaped = (method: ClassMethod): void => {
    const typeName = String(fieldOf(method, "returnTypeName"));
    if (fieldOf(method, "returnsShape") !== undefined || typeName.trim() === "" || typeName.trim() === "void") return;
    try {
      const shape = resolveTypeName(types, promisePayloadText(typeName) ?? typeName.trim());
      if (String(fieldOf(shape, "kind")) !== "any") (method as unknown as Record<string, unknown>)["returnsShape"] = shape;
    } catch {
      return;
    }
  };
  const constructorMethod = fieldOf(info, "constructor") as ClassMethod | null;
  if (constructorMethod !== null) shaped(constructorMethod);
  for (const method of fieldOf(info, "methods") as readonly ClassMethod[]) shaped(method);
  for (const method of fieldOf(info, "staticMethods") as readonly ClassMethod[]) shaped(method);
  for (const method of fieldOf(info, "getters") as readonly ClassMethod[]) shaped(method);
  for (const method of fieldOf(info, "staticGetters") as readonly ClassMethod[]) shaped(method);
  return info;
}

/** Reads each file at most once, so a diamond import costs one read. */
function cachingReader(read: (path: string) => string | null): (path: string) => string | null {
  const cache = new Map<string, string | null>();
  return (path) => {
    if (!cache.has(path)) cache.set(path, read(path));
    return cache.get(path) ?? null;
  };
}

/**
 * The values one file's runtime imports bind, by the name this file writes.
 *
 * A module that imports a value compiles a function that reads it, and a
 * compiled function has no environment to read another module's scope from:
 * what crosses is the value itself, and the module that wrote it read it where
 * the source wrote it.
 */
function importedValuesOf(
  record: ModuleRecord,
  records: ReadonlyMap<string, ModuleRecord>,
  imports: readonly ModuleImport[],
  resolved: readonly string[],
  offered: readonly OfferedValues[],
): { values: Map<string, unknown>; shapes: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const shapes = new Map<string, unknown>();
  for (let index = 0; index < imports.length; index += 1) {
    const entry = imports[index];
    if (fieldOf(entry, "default") === true) continue;
    let target: OfferedValues | undefined;
    for (const one of offered) if (String(fieldOf(one, "path")) === resolved[index]) target = one;
    if (target === undefined) continue;
    const names = fieldOf(entry, "names") as readonly string[] | null;
    for (const name of names ?? []) {
      const targetValues = fieldOf(target, "values") as Map<string, unknown>;
      const targetShapes = fieldOf(target, "shapes") as Map<string, unknown>;
      const held = targetValues.get(String(name));
      if (held !== undefined) values.set(String(name), held);
      const shape = targetShapes.get(String(name));
      if (shape !== undefined) {
        shapes.set(name, shape);
        const linked = new Set<string>();
        linkedShapeNames(shape as ResolvedType, linked);
        bindLinkedDeclarations(record, linked, records);
      }
    }
    // A value the file reads under another name is bound under that name: the
    // exported name is what the other module offers, and the alias is what this
    // file writes in the functions that read it.
    const renames = fieldOf(entry, "renames") as readonly { readonly local: string; readonly imported: string }[] | undefined;
    for (const rename of renames ?? []) {
      const targetValues = fieldOf(target, "values") as Map<string, unknown>;
      const targetShapes = fieldOf(target, "shapes") as Map<string, unknown>;
      const held = targetValues.get(String(fieldOf(rename, "imported")));
      if (held !== undefined) values.set(String(fieldOf(rename, "local")), held);
      const shape = targetShapes.get(String(fieldOf(rename, "imported")));
      if (shape !== undefined) shapes.set(String(fieldOf(rename, "local")), shape);
    }
  }
  return { values, shapes };
}

/**
 * Whether a specifier names an installed package.
 *
 * A relative path names a file of the project, and a specifier with a colon —
 * `node:fs`, `http:` — names a host module rather than a package. Everything
 * else is a package name, optionally followed by a path inside it.
 */
function isPackageSpecifier(request: ModuleGraphRequest, specifier: string): boolean {
  return (
    request.frontend.packages === true &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !specifier.includes(":")
  );
}

/** The package a specifier names, or null when it names a host module. */
function packageNameOf(request: ModuleGraphRequest, specifier: string): string | null {
  if (!isPackageSpecifier(request, specifier)) return null;
  const parts = specifier.split("/");
  const first = parts[0] as string;
  if (first === "") return null;
  if (first.startsWith("@")) {
    const second = parts[1];
    return second === undefined || second === "" ? null : `${first}/${second}`;
  }
  return first;
}

/** The directories `node_modules` may hold a package in, nearest first. */
function packageDirectories(from: string, name: string): string[] {
  const directories: string[] = [];
  let directory = dirname(from);
  while (true) {
    directories.push(join(join(directory, "node_modules"), name));
    if (directory === ".") return directories;
    const parent = dirname(directory);
    if (parent === directory) return directories;
    directory = parent;
  }
}

/**
 * The file a package's `exports` entry names.
 *
 * The entry is a text, a list of fallbacks, or the conditions it is offered
 * under. The compiler asks as an import of an ES module, so `import` is the
 * condition that answers, then the `node` and `default` conditions a package
 * writes for the same file.
 */
function exportedTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const one of value) {
      const found = exportedTarget(one);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const conditions = value as Record<string, unknown>;
  // The file is imported as an ES module, so `import` answers before the
  // `node` and `default` conditions a package writes for the same entry.
  for (const name of ["import", "node", "default", "module"]) {
    const found = exportedTarget(conditions[name]);
    if (found !== null) return found;
  }
  return null;
}

/** The file a package's `exports` field names for `key`. */
function exportTarget(exports: unknown, key: string): string | null {
  if (typeof exports === "string" || Array.isArray(exports)) {
    return key === "." ? exportedTarget(exports) : null;
  }
  if (exports === null || typeof exports !== "object") return null;
  const table = exports as Record<string, unknown>;
  // A field whose key names a subpath is the file it maps to.
  const direct = table[key];
  if (direct !== undefined) return exportedTarget(direct);
  // A field with no key that names a subpath is the conditions the package's
  // own entry is offered under. A package that maps subpaths names them with a
  // leading dot, and one it does not name is not offered at all.
  if (key === "." && (table["import"] !== undefined || table["default"] !== undefined)) {
    return exportedTarget(table);
  }
  return null;
}

/** The path inside a package a specifier names, or null when it holds none. */
function packageEntry(manifest: string, subpath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const fields = parsed as Record<string, unknown>;
  if (fields.exports !== undefined) return exportTarget(fields.exports, subpath === "" ? "." : `./${subpath}`);
  if (subpath !== "") return `./${subpath}`;
  // Without `exports`, a package is the entry its own manifest names, and
  // `index.js` when it names none.
  if (typeof fields.module === "string") return fields.module;
  if (typeof fields.main === "string") return fields.main;
  return "./index.js";
}

/** The file an entry names: the entry itself, or the extension it left out. */
function packageFile(read: (path: string) => string | null, path: string): string | null {
  const normalized = normalize(path);
  const candidates =
    extname(normalized) === "" ? [`${normalized}.js`, `${normalized}.mjs`, `${normalized}.ts`] : [normalized];
  for (const candidate of [...candidates, `${normalized}/index.js`]) {
    if (read(candidate) !== null) return candidate;
  }
  return null;
}

/**
 * The file an installed package offers under a specifier, or null.
 *
 * The walk is Node's: the `node_modules` of the importing file's directory,
 * then the `node_modules` of every directory above it. A package is the entry
 * its `exports` names — or its `module`, `main` or `index.js` — and the path
 * after the package name is a file inside the package.
 */
function resolvePackage(
  request: ModuleGraphRequest,
  read: (path: string) => string | null,
  from: string,
  specifier: string,
): string | null {
  const name = packageNameOf(request, specifier);
  if (name === null) return null;
  const subpath = specifier.length > name.length ? specifier.slice(name.length + 1) : "";
  for (const directory of packageDirectories(from, name)) {
    const manifest = read(`${directory}/package.json`);
    if (manifest === null) continue;
    const entry = packageEntry(manifest, subpath);
    if (entry === null) continue;
    const found = packageFile(read, `${directory}/${entry}`);
    if (found !== null) return found;
  }
  return null;
}

/** The candidate files an import specifier may name, joined onto the importer. */
function candidatePaths(
  request: ModuleGraphRequest,
  read: (path: string) => string | null,
  from: string,
  entry: { specifier: string },
): string[] {
  const specifier = String(fieldOf(entry, "specifier"));
  if (isPackageSpecifier(request, specifier)) {
    if (fieldOf(request, "resolvePackages") === false) return [];
    const found = resolvePackage(request, read, from, specifier);
    return found === null ? [] : [found];
  }
  const frontend = fieldOf(request, "frontend") as Frontend;
  return frontend.resolveImport(specifier).map((candidate) => modulePath(candidate, from));
}

/** The file an import names, resolved against the project, or null. */
function resolveImport(
  request: ModuleGraphRequest,
  read: (path: string) => string | null,
  from: string,
  entry: { specifier: string; line: number },
): string | null {
  // A project that pastes its source has no directory to resolve against.
  if (from === INLINE_MODULE) return null;
  const specifier = String(fieldOf(entry, "specifier"));
  const modules = fieldOf(request, "modules") as Readonly<Record<string, string>> | undefined;
  const mapped = modules === undefined ? undefined : modules[specifier];
  if (mapped !== undefined) return read(mapped) === null ? null : mapped;
  if (isHostSpecifier(specifier)) return null;
  if (isPackageSpecifier(request, specifier)) {
    return fieldOf(request, "resolvePackages") === false ? null : resolvePackage(request, read, from, specifier);
  }
  let candidates: string[];
  try {
    candidates = candidatePaths(request, read, from, entry);
  } catch {
    // A specifier the frontend does not resolve to a project module — a host
    // module — is a module the tree does not hold.
    return null;
  }
  return candidates.find((path) => read(path) !== null) ?? null;
}

/**
 * Whether a specifier names a host module rather than a file of the project.
 *
 * A colon is a scheme (`node:fs`); a leading `#` is the import map a package
 * writes in its own manifest (`#host/model`), which Node resolves to the host
 * adapter and a native build links against.
 */
function isHostSpecifier(specifier: string): boolean {
  return specifier.startsWith("#") || specifier.includes(":");
}

/**
 * The file an import names, or null where the host is what answers it.
 *
 * A host module is the boundary a build is linked against, not a file the tree
 * holds: `node:fs` names the adapter's own services, and a native adapter
 * answers the same names without a Node module. A graph that must hold every
 * import still holds the project's, and lets the host's name its boundary.
 */
function requireImport(
  request: ModuleGraphRequest,
  read: (path: string) => string | null,
  from: string,
  entry: { specifier: string; line: number },
): string | null {
  const specifier = String(fieldOf(entry, "specifier"));
  const line = Number(fieldOf(entry, "line"));
  if (from === INLINE_MODULE) {
    throw contractPhaseError(
      `an inline source cannot import "${specifier}"`,
      'set "sourceFile" to a file beside the project file so its imports can be resolved',
    );
  }
  const modules = fieldOf(request, "modules") as Readonly<Record<string, string>> | undefined;
  const mapped = modules === undefined ? undefined : modules[specifier];
  if (mapped !== undefined) {
    if (read(mapped) !== null) return mapped;
    throw contractPhaseError(
      `${from} imports "${specifier}" (line ${line}), which the project maps to ${mapped}`,
      `the mapped module is not a file of the project; fix the "${specifier}" entry in the project file`,
    );
  }
  if (isHostSpecifier(specifier)) return null;
  if (isPackageSpecifier(request, specifier)) {
    const resolved = fieldOf(request, "resolvePackages") === false ? null : resolvePackage(request, read, from, specifier);
    if (resolved !== null) return resolved;
    const name = packageNameOf(request, specifier) ?? specifier;
    throw contractPhaseError(
      `${from} imports "${specifier}" (line ${line}), which is not an installed package`,
      `looked for ${packageDirectories(from, name).join(", ")}; a package is read from the entry its package.json names`,
    );
  }
  const candidates = candidatePaths(request, read, from, entry);
  const resolved = candidates.find((path) => read(path) !== null);
  if (resolved !== undefined) return resolved;
  throw contractPhaseError(
    `${from} imports "${specifier}" (line ${line}), which is not a module of this project`,
    `looked for ${candidates.join(", ")}`,
  );
}

/** Joins a file name an import may name onto the importing file. */
function modulePath(candidate: string, from: string): string {
  return normalize(join(dirname(from), candidate));
}

/**
 * Reads every module the program reaches and links it.
 *
 * The first pass reads each file and resolves its imports. The types are linked
 * after every file is read, because a declaration may import one from a file
 * that is discovered later. Then a file that names a type, a value or a
 * signature its imports bind is read again with what they bind: that second
 * read is the one whose refusals are the file's, because it is the read a build
 * makes once the graph is whole.
 */
export function readModuleGraph(request: ModuleGraphRequest): ModuleRecord[] {
  const read = cachingReader(fieldOf(request, "read") as (path: string) => string | null);
  // A frontend that answers its refusals is read through that answer, so the
  // first analysis survives a construct that only waits for the link. The
  // verdict is written after the second read, where a build reports it.
  const frontend = fieldOf(request, "frontend") as Frontend;
  const reporting = fieldOf(frontend, "read") as ModuleReader | undefined;
  const givenReader = fieldOf(request, "reader") as ModuleReader | undefined;
  let reader: ModuleReader;
  if (givenReader !== undefined) {
    reader = givenReader;
  } else if (reporting !== undefined) {
    reader = (source, path, entry, context) => (fieldOf(frontend, "read") as ModuleReader)(source, path, entry, context);
  } else {
    reader = (source, path, entry, context) => {
      const analysis = (fieldOf(frontend, "analyze") as (source: string, path: string, entry: boolean, context: unknown) => ModuleAnalysis)(source, path, entry, context);
      return {
        analysis,
        refused: [],
        count: 0,
      };
    };
  }
  const records = new Map<string, ModuleRecord>();
  const entry = fieldOf(request, "entry") as { readonly path: string; readonly source: string };
  const entryPath = String(fieldOf(entry, "path"));
  const pending: string[] = [entryPath];
  for (const one of (fieldOf(request, "roots") as readonly string[] | undefined) ?? []) pending[pending.length] = one;

  while (pending.length > 0) {
    const path = pending.shift() as string;
    if (records.has(path)) continue;
    // A file the project names a replacement for is read from that file, and
    // the module keeps the name the import gave it. What the replacement
    // imports resolves beside the file it was written in, not beside the name
    // it answers for.
    const hostTable = fieldOf(request, "host") as Readonly<Record<string, string>> | undefined;
    const sourcePath = hostTable === undefined || hostTable[path] === undefined ? path : hostTable[path];
    const source = path === entryPath ? String(fieldOf(entry, "source")) : read(sourcePath);
    if (source === null) throw contractPhaseError(`cannot read module ${path}`);
    if (source.trim() === "") throw contractPhaseError(`module ${path} is empty`);

    const first = reader(source, path, path === entryPath, undefined);
    const record: ModuleRecord = {
      path,
      source,
      analysis: fieldOf(first, "analysis") as ModuleAnalysis,
      resolved: [],
      typeResolved: [],
      refused: fieldOf(first, "refused") as Diagnostic[],
      refusedCount: Number(fieldOf(first, "count")),
    };
    records.set(path, record);
    const strict = fieldOf(request, "requireImports") !== false;
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    for (const imported of fieldOf(analysis, "imports") as readonly ModuleImport[]) {
      const resolved = strict
        ? requireImport(request, read, sourcePath, imported)
        : resolveImport(request, read, sourcePath, imported);
      // An import left unbound keeps its place, so the resolved list still
      // answers by the index the imports are written at.
      record.resolved.push(resolved ?? "");
      if (resolved !== null) pending.push(resolved);
    }
    // A type import names a file the program may not otherwise reach, and the
    // file that writes the declaration is where its fields resolve. It is
    // followed beside the runtime imports but is never checked for a symbol.
    for (const imported of (fieldOf(analysis, "typeImports") as readonly ModuleTypeImport[] | undefined) ?? []) {
      const resolved = strict
        ? requireImport(request, read, sourcePath, imported)
        : resolveImport(request, read, sourcePath, imported);
      record.typeResolved.push(resolved ?? "");
      if (resolved !== null) pending.push(resolved);
    }
  }

  // The types are linked after every file is read, because a declaration may
  // import one from a file that was discovered later. A module that re-exports
  // a type it imported offers a name only once the module it imported from has
  // been linked, and the records are walked in discovery order, so the bind is
  // repeated until no table gains a declaration. The table object is the one
  // the first read built, and the second read reuses it: a declaration an
  // importer already holds keeps resolving through the module that wrote it.
  const tables = new Map<string, TypeTable>();
  for (const record of records.values()) {
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    const types = fieldOf(analysis, "types") as TypeTable | undefined;
    if (types !== undefined) tables.set(String(fieldOf(record, "path")), types);
  }
  for (let linked = true; linked; ) {
    linked = false;
    for (const record of records.values()) {
      const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
      const types = fieldOf(analysis, "types") as TypeTable | undefined;
      const imports = fieldOf(analysis, "typeImports") as readonly ModuleTypeImport[] | undefined;
      if (types === undefined || imports === undefined) continue;
      const typeResolved = fieldOf(record, "typeResolved") as readonly string[];
      const targets = new Map<string, TypeTable>();
      for (let index = 0; index < imports.length; index += 1) {
        const target = tables.get(typeResolved[index] as string);
        if (target !== undefined) targets.set(String(fieldOf(imports[index], "specifier")), target);
      }
      if (bindImportedTypes(types, imports, targets)) linked = true;
    }
  }
  // A class crosses the link as the description of itself: the fields a value
  // has and the methods it answers, which are functions the declaring module
  // compiled. The table is the first read's, so the second read sees them.
  const classTables = new Map<string, ClassTable>();
  for (const record of records.values()) {
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    const classes = fieldOf(analysis, "classes") as ClassTable | undefined;
    if (classes !== undefined) classTables.set(String(fieldOf(record, "path")), classes);
  }
  // A class a module re-exports under a name it imports is bound in that
  // module's own table, and a file that imports it from there reads it. Which
  // module is read first is not fixed, so the binding runs again while it adds
  // anything: the description crosses one module at a time.
  let classesLinked = true;
  while (classesLinked) {
    classesLinked = false;
    for (const record of records.values()) {
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    const table = fieldOf(analysis, "classes") as ClassTable | undefined;
    if (table === undefined) continue;
    const imports = fieldOf(analysis, "imports") as readonly ModuleImport[];
    const resolved = fieldOf(record, "resolved") as readonly string[];
    const targets = new Map<string, ModuleRecord>();
    for (let index = 0; index < imports.length; index += 1) {
      const target = records.get(resolved[index] as string);
      if (target !== undefined) targets.set(String(fieldOf(imports[index], "specifier")), target);
    }
    // A type-only import names a class the file reads through a value it was
    // handed — `private readonly diagnostics: Diagnostics` — and the methods
    // written on that value are the class's. Nothing is imported at run time
    // either way: what crosses is the description.
    const typeImports = fieldOf(analysis, "typeImports") as readonly ModuleTypeImport[] | undefined;
    const typeResolved = fieldOf(record, "typeResolved") as readonly string[];
    for (let index = 0; index < (typeImports?.length ?? 0); index += 1) {
      const target = records.get(typeResolved[index] as string);
      const entry = typeImports?.[index];
      if (target !== undefined && entry !== undefined) targets.set(String(fieldOf(entry, "specifier")), target);
    }
    const typeNames: { specifier: string; names: string[] | null; renames?: readonly { local: string; imported: string }[] }[] = [];
    for (const entry of typeImports ?? []) {
      const renames: { local: string; imported: string }[] = [];
      for (const name of fieldOf(entry, "names") as readonly { readonly local: string; readonly imported: string }[]) renames[renames.length] = name;
      typeNames[typeNames.length] = { specifier: String(fieldOf(entry, "specifier")), names: null, renames };
    }
    const allImports: { specifier: string; names: string[] | null; renames?: readonly { local: string; imported: string }[] }[] = [];
    for (const one of imports) allImports[allImports.length] = one;
    for (const one of typeNames) allImports[allImports.length] = one;
    if (bindImportedClasses(table, allImports, (specifier, name) => {
      const target = targets.get(specifier);
      return target === undefined ? undefined : classOffered(target, name, records, new Set());
    })) classesLinked = true;
    }
  }
  // A file is read again with the table its imports now fill, and with the
  // values its imports bind. Its runtime imports were resolved by the first
  // read and are unchanged, so only the analysis is replaced.
  //
  // The files are read in the order a module depends on another: what a file
  // imports is read before it, so a signature it links carries the shapes the
  // module that declares them resolved. A file read before the module that
  // declares the type its result names states no shape for that result, and
  // the field a caller reads through it is the opaque reference.
  for (const record of bindingOrder(records)) {
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    if (fieldOf(analysis, "types") === undefined) continue;
    const offered = offeredValues([...records.values()]);
    const imports = fieldOf(analysis, "typeImports") as readonly ModuleTypeImport[] | undefined ?? [];
    const typeResolved = fieldOf(record, "typeResolved") as readonly string[];
    const runtimeImports = fieldOf(analysis, "imports") as readonly ModuleImport[];
    const resolved = fieldOf(record, "resolved") as readonly string[];
    // A second read is only needed when an import names a module that actually
    // declares a type or a class, or offers a value. A runtime import binds
    // none of them, and most files have one: reading every file twice for
    // nothing would double the parse of the whole tree. A file that waited for
    // the link is read again whatever its imports turned out to hold, because
    // what it deferred is the link's to answer one way or the other.
    let namesAType = false;
    for (let index = 0; index < imports.length; index += 1) {
      const target = tables.get(typeResolved[index] as string);
      if (target !== undefined && (fieldOf(target, "declarations") as Map<string, unknown>).size > 0) {
        namesAType = true;
        break;
      }
    }
    let namesAClass = false;
    if (!namesAType) {
      for (let index = 0; index < runtimeImports.length; index += 1) {
        const target = classTables.get(resolved[index] as string);
        if (target !== undefined && (fieldOf(target, "classes") as Map<string, unknown>).size > 0) {
          namesAClass = true;
          break;
        }
      }
    }
    const imported = importedValuesOf(record, records, runtimeImports, resolved, offered);
    const values = fieldOf(imported, "values") as Map<string, unknown>;
    // The signatures of the functions this file calls are what a call answers,
    // and the graph has read the modules that write them by now.
    const functions = importedFunctionsOf(record, records);
    const importedShapes = fieldOf(imported, "shapes") as Map<string, unknown>;
    if (!namesAType && !namesAClass && values.size === 0 && importedShapes.size === 0 && functions.size === 0 && fieldOf(analysis, "awaitingLink") !== true) continue;
    const second = reader(String(fieldOf(record, "source")), String(fieldOf(record, "path")), String(fieldOf(record, "path")) === entryPath, {
      table: fieldOf(analysis, "types") as TypeTable | undefined,
      classes: fieldOf(analysis, "classes") as ClassTable | undefined,
      values,
      valueShapes: importedShapes,
      functions,
      linked: true,
    });
    (record as unknown as Record<string, unknown>)["analysis"] = fieldOf(second, "analysis");
    (record as unknown as Record<string, unknown>)["refused"] = fieldOf(second, "refused");
    (record as unknown as Record<string, unknown>)["refusedCount"] = fieldOf(second, "count");
    // The linked read names the imports again, and a file that re-exports a
    // name adds an import the first read may have written after it: the paths
    // are resolved against the analysis the contract is built from, so every
    // import is paired with the module it names.
    const strict = fieldOf(request, "requireImports") !== false;
    // A replacement's own imports resolve beside the file it is written in,
    // in the linked read as in the first: the module keeps the name the
    // import gave it, and the host table names the file that answers for it.
    const hostTable = fieldOf(request, "host") as Readonly<Record<string, string>> | undefined;
    const recordPath = String(fieldOf(record, "path"));
    const sourcePath = hostTable === undefined || hostTable[recordPath] === undefined ? recordPath : hostTable[recordPath];
    const linkedAnalysis = fieldOf(record, "analysis") as ModuleAnalysis;
    const nextResolved: string[] = [];
    for (const imported of fieldOf(linkedAnalysis, "imports") as readonly ModuleImport[]) {
      const found = strict ? requireImport(request, read, sourcePath, imported) : resolveImport(request, read, sourcePath, imported);
      nextResolved[nextResolved.length] = found ?? "";
    }
    (record as unknown as Record<string, unknown>)["resolved"] = nextResolved;
    const nextTypeResolved: string[] = [];
    for (const imported of (fieldOf(linkedAnalysis, "typeImports") as readonly ModuleTypeImport[] | undefined) ?? []) {
      const found = strict ? requireImport(request, read, sourcePath, imported) : resolveImport(request, read, sourcePath, imported);
      nextTypeResolved[nextTypeResolved.length] = found ?? "";
    }
    (record as unknown as Record<string, unknown>)["typeResolved"] = nextTypeResolved;
  }
  // A file is read to the end whatever it holds, and the linked read is the
  // one whose refusals are the file's: a construct that waited for an import is
  // settled by now, and what is left is what the build names. A measurement
  // supplies its own reader and counts the refusals itself, so it is not
  // stopped here.
  if (fieldOf(request, "reader") === undefined) {
    for (const record of records.values()) {
      const refused = fieldOf(record, "refused") as readonly Diagnostic[];
      const refusedCount = Number(fieldOf(record, "refusedCount"));
      if (refused.length === 0 && refusedCount === 0) continue;
      throw refusalError(String(fieldOf(record, "path")), refused, refusedCount);
    }
  }

  markReachableHelpers([...records.values()], String(fieldOf(entry, "path")));
  return [...records.values()];
}

/**
 * Every name a body calls, wherever the body is nested: a call is written as a
 * call expression and a program's statement as an invocation, and a body may
 * hold another body beside either.
 */
function callNamesIn(node: unknown, names: Set<string>, seen: Set<object> = new Set()): void {
  if (Array.isArray(node)) {
    for (const value of node) callNamesIn(value, names, seen);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (seen.has(node)) return;
  seen.add(node);
  const record = node as Record<string, unknown>;
  if (record.k === "call" && typeof record.name === "string") names.add(record.name);
  if (record.k === "call" && typeof record.function === "string") names.add(record.function);
  if (record.kind === "invoke" && typeof record.function === "string") names.add(record.function);
  for (const value of Object.values(record)) callNamesIn(value, names, seen);
}

/**
 * The private functions a compiled function calls are compiled with it.
 *
 * A module offers its exports, and a function it keeps to itself is still a
 * body a build has to compile when an exported function calls it: the link
 * reaches it by symbol, and a symbol no unit was compiled under is a link
 * error. The frontend marks the functions a class is lowered to as internal
 * because a source names the class and not them; this marks the helpers a
 * source calls by their own names for the same reason. It walks from the
 * exports and the program body, so a private function nothing calls is still
 * not compiled — a tree is measured by what a build reads, and a build reads
 * what its program reaches.
 */
function markReachableHelpers(records: readonly ModuleRecord[], entryPath: string): void {
  for (const record of records) {
    const analysis = fieldOf(record, "analysis") as ModuleAnalysis;
    const functions = fieldOf(analysis, "functions") as readonly DeclaredFunction[];
    const declared = new Map<string, DeclaredFunction>();
    for (const entry of functions) declared.set(String(fieldOf(entry, "name")), entry);
    const reached = new Set<string>();
    const worklist: DeclaredFunction[] = [];
    for (const entry of functions) {
      const exported = fieldOf(entry, "exported") === true;
      const internal = fieldOf(entry, "internal") === true;
      if (exported || internal) {
        worklist.push(entry);
      }
    }
    const visit = (names: ReadonlySet<string>): void => {
      for (const name of names) {
        const entry = declared.get(name);
        if (entry === undefined || reached.has(name)) continue;
        reached.add(name);
        worklist.push(entry);
      }
    };
    if (String(fieldOf(record, "path")) === entryPath) {
      const bodyCalls = new Set<string>();
      callNamesIn(fieldOf(analysis, "body") ?? [], bodyCalls, undefined);
      visit(bodyCalls);
    }
    while (worklist.length > 0) {
      const entry = worklist.pop() as DeclaredFunction;
      const calls = new Set<string>();
      callNamesIn(fieldOf(entry, "handle"), calls, undefined);
      visit(calls);
    }
    for (const name of reached) {
      const entry = declared.get(name);
      if (entry !== undefined && fieldOf(entry, "exported") !== true) (entry as unknown as Record<string, unknown>)["internal"] = true;
    }
  }
}

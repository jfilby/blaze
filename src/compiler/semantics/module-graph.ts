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

import { posix } from "../core/platform.ts";
import { CompilerError } from "../core/errors.ts";
import type { SourceModule, TypeExpr } from "../core/types.ts";
import { refusalError, type Diagnostic } from "./diagnostics.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport } from "./module.ts";
import type { ImportedFunction } from "./typescript.ts";
import { bindImportedClasses } from "./typescript-classes.ts";
import type { ClassInfo, ClassMethod, ClassTable } from "./typescript-classes.ts";
import { bindImportedTypes, promisePayloadText, resolveTypeName } from "./typescript-types.ts";
import type { ResolvedType, TypeTable } from "./typescript-types.ts";

/** An error of the contract phase, which is where the graph is read. */
export function contractPhaseError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "ContractError", stage: "contract", message, detail });
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
  values: ReadonlyMap<string, unknown>;
  /** The type each offered declaration writes, where its value is not one the
   *  file wrote out. */
  shapes: ReadonlyMap<string, unknown>;
}

/** The values every module of the program offers, in discovery order. */
export function offeredValues(records: readonly ModuleRecord[]): OfferedValues[] {
  const offered: OfferedValues[] = [];
  for (const record of records) {
    const values = record.analysis.constants as ReadonlyMap<string, unknown> | undefined;
    const shapes = record.analysis.valueShapes as ReadonlyMap<string, unknown> | undefined;
    if (values !== undefined || shapes !== undefined) {
      offered.push({ path: record.path, values: values ?? new Map(), shapes: shapes ?? new Map() });
    }
  }
  return offered;
}

/** The names a contract type names, which are the declarations it links. */
function linkedTypeNames(type: TypeExpr, into: Set<string>): void {
  if (type.kind === "ref") {
    if (typeof type.name === "string") into.add(type.name);
    if (type.of !== null) linkedTypeNames(type.of, into);
    return;
  }
  if (type.kind === "ptr" || type.kind === "slice" || type.kind === "array") {
    linkedTypeNames(type.of, into);
  }
}

/** The names a value's shape names, which are the declarations it links. */
function linkedShapeNames(shape: ResolvedType, into: Set<string>): void {
  if (shape.kind === "ref") {
    if (shape.name !== null) into.add(shape.name);
    return;
  }
  if (shape.kind === "list" || shape.kind === "set") {
    linkedShapeNames(shape.of, into);
    return;
  }
  if (shape.kind === "map") {
    linkedShapeNames(shape.key, into);
    linkedShapeNames(shape.value, into);
    return;
  }
  if (shape.kind === "record") {
    for (const field of shape.fields.values()) linkedShapeNames(field.type, into);
    if (shape.index !== null) linkedShapeNames(shape.index, into);
    return;
  }
  if (shape.kind === "function") {
    for (const param of shape.params) linkedShapeNames(param, into);
    linkedShapeNames(shape.returns, into);
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
  const ownTypes = record.analysis.types;
  const ownClasses = record.analysis.classes;
  // A declaration names other declarations: an interface's fields, a base it
  // extends, an alias's target, a class's fields and methods. A value of the
  // interface read in this file needs those names too, because a field is read
  // through the type the declaration gives it. The work list is the names the
  // linked types name, expanded until it names nothing new.
  const pending = [...names];
  const seen = new Set<string>(pending);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (ownTypes !== undefined && !ownTypes.declarations.has(name) && !ownTypes.imported.has(name)) {
      for (const source of records.values()) {
        const types = source.analysis.types;
        if (types === undefined) continue;
        const declared = types.declarations.get(name) ?? types.exported.get(name) ?? types.imported.get(name);
        if (declared === undefined) continue;
        ownTypes.imported.set(name, declared);
        const named = new Set<string>();
        for (const field of declared.fields.values()) linkedNamesInText(field.typeName, named);
        for (const base of declared.extends) linkedNamesInText(base, named);
        if (declared.target !== null) linkedNamesInText(declared.target, named);
        for (const next of named) {
          if (seen.has(next)) continue;
          seen.add(next);
          pending.push(next);
        }
        break;
      }
    }
    if (ownClasses !== undefined && !ownClasses.names.has(name)) {
      for (const source of records.values()) {
        const offered = classOffered(source, name, records, new Set());
        if (offered === undefined) continue;
        ownClasses.names.add(name);
        ownClasses.classes.set(name, offered);
        const named = new Set<string>();
        for (const field of offered.fields) linkedNamesInText(field.typeName, named);
        for (const method of [...offered.methods, ...offered.getters]) {
          linkedNamesInText(method.returnTypeName, named);
          for (const param of method.params) linkedNamesInText(param.typeName, named);
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
function importedFunctionsOf(
  record: ModuleRecord,
  records: ReadonlyMap<string, ModuleRecord>,
): Map<string, ImportedFunction> {
  const functions = new Map<string, ImportedFunction>();
  record.analysis.imports.forEach((entry, index) => {
    if (entry.default || entry.names === null) return;
    const target = records.get(record.resolved[index] ?? "");
    if (target === undefined) return;
    // A name the file imports under another name is seeded under the name this
    // file writes: a call is read against that name and emitted under the one
    // the other module exports.
    const named: { local: string; imported: string }[] = entry.names.map((name) => ({ local: name, imported: name }));
    for (const rename of entry.renames ?? []) named.push(rename);
    for (const { local, imported } of named) {
      // A file whose body could not be held still offers the signatures of what
      // it exports: the declaration is refused where it is written, and the
      // calls a file writes to it are read against the parameters and result
      // the declaration states.
      const declared = declaredOffered(target, imported, records, new Set());
      if (declared === undefined) {
        // A value the exporting module holds is offered under the value's name
        // and read through the getter function the module wrote for it.
        const getterName = target.analysis.valueGetters?.get(imported);
        const getter =
          getterName === undefined ? undefined : target.analysis.functions.find((entry) => entry.name === getterName);
        if (getter !== undefined) {
          const signature: ImportedFunction = {
            params: getter.params.map((param) => param.type),
            returns: getter.returns,
            valueGetter: true,
          };
          const linked = new Set<string>();
          for (const param of getter.params) linkedTypeNames(param.type, linked);
          linkedTypeNames(getter.returns, linked);
          bindLinkedDeclarations(record, linked, records);
          functions.set(local, signature);
        }
        continue;
      }
      const signature: ImportedFunction = {
        params: declared.params.map((param) => param.type),
        returns: declared.returns,
      };
      const handle = declared.handle as {
        returnsShape?: ImportedFunction["shape"];
        collection?: ImportedFunction["collection"];
        params?: readonly { shape?: ResolvedType | null }[];
        async?: boolean;
      } | undefined;
      if (handle?.async === true) signature.async = true;
      if (handle?.returnsShape !== undefined) signature.shape = handle.returnsShape;
      if (handle?.collection !== undefined) signature.collection = handle.collection;
      const paramShapes = handle?.params?.map((param) => param.shape ?? null);
      if (paramShapes !== undefined) signature.paramShapes = paramShapes;
      const linked = new Set<string>();
      for (const param of declared.params) linkedTypeNames(param.type, linked);
      linkedTypeNames(declared.returns, linked);
      bindLinkedDeclarations(record, linked, records);
      functions.set(local, signature);
    }
  });
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
  const visit = (record: ModuleRecord): void => {
    if (seen.has(record.path)) return;
    seen.add(record.path);
    for (const path of [...record.resolved, ...record.typeResolved]) {
      const imported = records.get(path);
      if (imported !== undefined) visit(imported);
    }
    order.push(record);
  };
  for (const record of records.values()) visit(record);
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
  if (seen.has(record.path)) return undefined;
  seen.add(record.path);
  // `export { f as g }` offers `f` under the name `g`: the declaration is the
  // one `f` names, and the caller writes `g`.
  const renamed = record.analysis.exportNames?.find((one) => one.exported === name);
  const local = renamed === undefined ? name : renamed.local;
  const held = record.analysis.functions.find((one) => one.name === local && (one.exported || renamed !== undefined)) ??
    (record.analysis.signatures ?? []).find((one) => one.name === local);
  if (held !== undefined) {
    return renamed === undefined ? held : { ...held, name };
  }
  for (const entry of record.analysis.reexports ?? []) {
    // A re-export may offer the other module's name under another name here.
    const offered = entry.renames?.find((one) => one.exported === name);
    const wanted = offered === undefined ? name : offered.local;
    if (!entry.names.includes(wanted)) continue;
    const index = record.analysis.imports.findIndex((one) => one.specifier === entry.specifier);
    if (index < 0) continue;
    const target = records.get(record.resolved[index] ?? "");
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
  if (seen.has(record.path)) return undefined;
  seen.add(record.path);
  const renamed = record.analysis.exportNames?.find((one) => one.exported === name);
  const local = renamed === undefined ? name : renamed.local;
  const held = record.analysis.classes?.classes.get(local);
  if (held !== undefined) return withMethodShapes(held, record);
  for (const entry of record.analysis.reexports ?? []) {
    const offered = entry.renames?.find((one) => one.exported === name);
    const wanted = offered === undefined ? name : offered.local;
    if (!entry.names.includes(wanted)) continue;
    const index = record.analysis.imports.findIndex((one) => one.specifier === entry.specifier);
    if (index < 0) continue;
    const target = records.get(record.resolved[index] ?? "");
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
  const types = record.analysis.types;
  if (types === undefined) return info;
  const shaped = (method: ClassMethod): ClassMethod => {
    if (method.returnsShape !== undefined || method.returnTypeName.trim() === "" || method.returnTypeName.trim() === "void") return method;
    try {
      const shape = resolveTypeName(types, promisePayloadText(method.returnTypeName) ?? method.returnTypeName.trim());
      return shape.kind === "any" ? method : { ...method, returnsShape: shape };
    } catch {
      return method;
    }
  };
  return {
    ...info,
    constructor: info.constructor === null ? null : shaped(info.constructor),
    methods: info.methods.map(shaped),
    staticMethods: info.staticMethods.map(shaped),
    getters: info.getters.map(shaped),
    staticGetters: info.staticGetters.map(shaped),
  };
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
  imports.forEach((entry, index) => {
    if (entry.default) return;
    const target = offered.find((one) => one.path === resolved[index]);
    if (target === undefined) return;
    for (const name of entry.names ?? []) {
      const held = target.values.get(name);
      if (held !== undefined) values.set(name, held);
      const shape = target.shapes.get(name);
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
    for (const rename of entry.renames ?? []) {
      const held = target.values.get(rename.imported);
      if (held !== undefined) values.set(rename.local, held);
      const shape = target.shapes.get(rename.imported);
      if (shape !== undefined) shapes.set(rename.local, shape);
    }
  });
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
  let directory = posix.dirname(from);
  while (true) {
    directories.push(posix.join(directory, "node_modules", name));
    if (directory === ".") return directories;
    const parent = posix.dirname(directory);
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
  const normalized = posix.normalize(path);
  const candidates =
    posix.extname(normalized) === "" ? [`${normalized}.js`, `${normalized}.mjs`, `${normalized}.ts`] : [normalized];
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
  if (isPackageSpecifier(request, entry.specifier)) {
    if (request.resolvePackages === false) return [];
    const found = resolvePackage(request, read, from, entry.specifier);
    return found === null ? [] : [found];
  }
  return request.frontend.resolveImport(entry.specifier).map((candidate) => modulePath(candidate, from));
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
  const mapped = request.modules?.[entry.specifier];
  if (mapped !== undefined) return read(mapped) === null ? null : mapped;
  if (isHostSpecifier(entry.specifier)) return null;
  if (isPackageSpecifier(request, entry.specifier)) {
    return request.resolvePackages === false ? null : resolvePackage(request, read, from, entry.specifier);
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
  if (from === INLINE_MODULE) {
    throw contractPhaseError(
      `an inline source cannot import "${entry.specifier}"`,
      'set "sourceFile" to a file beside the project file so its imports can be resolved',
    );
  }
  const mapped = request.modules?.[entry.specifier];
  if (mapped !== undefined) {
    if (read(mapped) !== null) return mapped;
    throw contractPhaseError(
      `${from} imports "${entry.specifier}" (line ${entry.line}), which the project maps to ${mapped}`,
      `the mapped module is not a file of the project; fix the "${entry.specifier}" entry in the project file`,
    );
  }
  if (isHostSpecifier(entry.specifier)) return null;
  if (isPackageSpecifier(request, entry.specifier)) {
    const resolved = request.resolvePackages === false ? null : resolvePackage(request, read, from, entry.specifier);
    if (resolved !== null) return resolved;
    const name = packageNameOf(request, entry.specifier) ?? entry.specifier;
    throw contractPhaseError(
      `${from} imports "${entry.specifier}" (line ${entry.line}), which is not an installed package`,
      `looked for ${packageDirectories(from, name).join(", ")}; a package is read from the entry its package.json names`,
    );
  }
  const candidates = candidatePaths(request, read, from, entry);
  const resolved = candidates.find((path) => read(path) !== null);
  if (resolved !== undefined) return resolved;
  throw contractPhaseError(
    `${from} imports "${entry.specifier}" (line ${entry.line}), which is not a module of this project`,
    `looked for ${candidates.join(", ")}`,
  );
}

/** Joins a file name an import may name onto the importing file. */
function modulePath(candidate: string, from: string): string {
  return posix.normalize(posix.join(posix.dirname(from), candidate));
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
  const read = cachingReader(request.read);
  // A frontend that answers its refusals is read through that answer, so the
  // first analysis survives a construct that only waits for the link. The
  // verdict is written after the second read, where a build reports it.
  const reporting = request.frontend.read;
  let reader: ModuleReader;
  if (request.reader !== undefined) {
    reader = request.reader;
  } else if (reporting !== undefined) {
    reader = (source, path, entry, context) => reporting(source, path, entry, context);
  } else {
    reader = (source, path, entry, context) => ({
      analysis: request.frontend.analyze(source, path, entry, context),
      refused: [],
      count: 0,
    });
  }
  const records = new Map<string, ModuleRecord>();
  const pending = [request.entry.path, ...(request.roots ?? [])];

  while (pending.length > 0) {
    const path = pending.shift() as string;
    if (records.has(path)) continue;
    const source = path === request.entry.path ? request.entry.source : read(path);
    if (source === null) throw contractPhaseError(`cannot read module ${path}`);
    if (source.trim() === "") throw contractPhaseError(`module ${path} is empty`);

    const first = reader(source, path, path === request.entry.path);
    const record: ModuleRecord = {
      path,
      source,
      analysis: first.analysis,
      resolved: [],
      typeResolved: [],
      refused: first.refused,
      refusedCount: first.count,
    };
    records.set(path, record);
    const strict = request.requireImports !== false;
    for (const entry of record.analysis.imports) {
      const resolved = strict
        ? requireImport(request, read, path, entry)
        : resolveImport(request, read, path, entry);
      // An import left unbound keeps its place, so the resolved list still
      // answers by the index the imports are written at.
      record.resolved.push(resolved ?? "");
      if (resolved !== null) pending.push(resolved);
    }
    // A type import names a file the program may not otherwise reach, and the
    // file that writes the declaration is where its fields resolve. It is
    // followed beside the runtime imports but is never checked for a symbol.
    for (const entry of record.analysis.typeImports ?? []) {
      const resolved = strict
        ? requireImport(request, read, path, entry)
        : resolveImport(request, read, path, entry);
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
    if (record.analysis.types !== undefined) tables.set(record.path, record.analysis.types);
  }
  for (let linked = true; linked; ) {
    linked = false;
    for (const record of records.values()) {
      const types = record.analysis.types;
      const imports = record.analysis.typeImports;
      if (types === undefined || imports === undefined) continue;
      const targets = new Map<string, TypeTable>();
      for (let index = 0; index < imports.length; index += 1) {
        const target = tables.get(record.typeResolved[index] as string);
        if (target !== undefined) targets.set((imports[index] as { specifier: string }).specifier, target);
      }
      if (bindImportedTypes(types, imports, targets)) linked = true;
    }
  }
  // A class crosses the link as the description of itself: the fields a value
  // has and the methods it answers, which are functions the declaring module
  // compiled. The table is the first read's, so the second read sees them.
  const classTables = new Map<string, ClassTable>();
  for (const record of records.values()) {
    if (record.analysis.classes !== undefined) classTables.set(record.path, record.analysis.classes);
  }
  // A class a module re-exports under a name it imports is bound in that
  // module's own table, and a file that imports it from there reads it. Which
  // module is read first is not fixed, so the binding runs again while it adds
  // anything: the description crosses one module at a time.
  let classesLinked = true;
  while (classesLinked) {
    classesLinked = false;
    for (const record of records.values()) {
    const table = record.analysis.classes;
    if (table === undefined) continue;
    const targets = new Map<string, ModuleRecord>();
    for (let index = 0; index < record.analysis.imports.length; index += 1) {
      const target = records.get(record.resolved[index] as string);
      const entry = record.analysis.imports[index] as { specifier: string };
      if (target !== undefined) targets.set(entry.specifier, target);
    }
    // A type-only import names a class the file reads through a value it was
    // handed — `private readonly diagnostics: Diagnostics` — and the methods
    // written on that value are the class's. Nothing is imported at run time
    // either way: what crosses is the description.
    for (let index = 0; index < (record.analysis.typeImports?.length ?? 0); index += 1) {
      const target = records.get(record.typeResolved[index] as string);
      const entry = record.analysis.typeImports?.[index] as { specifier: string } | undefined;
      if (target !== undefined && entry !== undefined) targets.set(entry.specifier, target);
    }
    const typeNames = (record.analysis.typeImports ?? []).map((entry) => ({
      specifier: entry.specifier,
      names: null as string[] | null,
      renames: entry.names.map((name) => ({ local: name.local, imported: name.imported })),
    }));
    if (bindImportedClasses(table, [...record.analysis.imports, ...typeNames], (specifier, name) => {
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
    if (record.analysis.types === undefined) continue;
    const offered = offeredValues([...records.values()]);
    const imports = record.analysis.typeImports ?? [];
    // A second read is only needed when an import names a module that actually
    // declares a type or a class, or offers a value. A runtime import binds
    // none of them, and most files have one: reading every file twice for
    // nothing would double the parse of the whole tree. A file that waited for
    // the link is read again whatever its imports turned out to hold, because
    // what it deferred is the link's to answer one way or the other.
    let namesAType = false;
    for (let index = 0; index < imports.length; index += 1) {
      const target = tables.get(record.typeResolved[index] as string);
      if (target !== undefined && target.declarations.size > 0) {
        namesAType = true;
        break;
      }
    }
    let namesAClass = false;
    if (!namesAType) {
      for (let index = 0; index < record.analysis.imports.length; index += 1) {
        const target = classTables.get(record.resolved[index] as string);
        if (target !== undefined && target.classes.size > 0) {
          namesAClass = true;
          break;
        }
      }
    }
    const imported = importedValuesOf(record, records, record.analysis.imports, record.resolved, offered);
    const values = imported.values;
    // The signatures of the functions this file calls are what a call answers,
    // and the graph has read the modules that write them by now.
    const functions = importedFunctionsOf(record, records);
    if (!namesAType && !namesAClass && values.size === 0 && imported.shapes.size === 0 && functions.size === 0 && record.analysis.awaitingLink !== true) continue;
    const second = reader(record.source, record.path, record.path === request.entry.path, {
      table: record.analysis.types,
      classes: record.analysis.classes,
      values,
      valueShapes: imported.shapes,
      functions,
      linked: true,
    });
    record.analysis = second.analysis;
    record.refused = second.refused;
    record.refusedCount = second.count;
    // The linked read names the imports again, and a file that re-exports a
    // name adds an import the first read may have written after it: the paths
    // are resolved against the analysis the contract is built from, so every
    // import is paired with the module it names.
    const strict = request.requireImports !== false;
    record.resolved = record.analysis.imports.map((entry) => {
      const resolved = strict ? requireImport(request, read, record.path, entry) : resolveImport(request, read, record.path, entry);
      return resolved ?? "";
    });
    record.typeResolved = (record.analysis.typeImports ?? []).map((entry) => {
      const resolved = strict ? requireImport(request, read, record.path, entry) : resolveImport(request, read, record.path, entry);
      return resolved ?? "";
    });
  }
  // A file is read to the end whatever it holds, and the linked read is the
  // one whose refusals are the file's: a construct that waited for an import is
  // settled by now, and what is left is what the build names. A measurement
  // supplies its own reader and counts the refusals itself, so it is not
  // stopped here.
  if (request.reader === undefined) {
    for (const record of records.values()) {
      if (record.refused.length === 0 && record.refusedCount === 0) continue;
      throw refusalError(record.path, record.refused, record.refusedCount);
    }
  }

  markReachableHelpers([...records.values()], request.entry.path);
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
    const declared = new Map(record.analysis.functions.map((entry) => [entry.name, entry]));
    const reached = new Set<string>();
    const queue = record.analysis.functions.filter((entry) => entry.exported || entry.internal === true);
    const visit = (names: ReadonlySet<string>): void => {
      for (const name of names) {
        const entry = declared.get(name);
        if (entry === undefined || reached.has(name)) continue;
        reached.add(name);
        queue.push(entry);
      }
    };
    if (record.path === entryPath) {
      const bodyCalls = new Set<string>();
      callNamesIn(record.analysis.body ?? [], bodyCalls);
      visit(bodyCalls);
    }
    while (queue.length > 0) {
      const entry = queue.pop() as (typeof record.analysis.functions)[number];
      const calls = new Set<string>();
      callNamesIn(entry.handle, calls);
      visit(calls);
    }
    for (const name of reached) {
      const entry = declared.get(name);
      if (entry !== undefined && !entry.exported) entry.internal = true;
    }
  }
}

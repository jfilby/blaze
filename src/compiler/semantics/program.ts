/**
 * The whole-program contract phase.
 *
 *   source analysis -> contract generation -> contract validation -> target
 *
 * Every source file of the program is read and parsed, every exported function
 * in it is contracted, and the result is validated as a whole: imports must
 * resolve, imported symbols must exist with a contract, the entry must be an
 * export of the entry file. Only when the program contract is complete and
 * valid does it leave this module, and nothing else in the compiler may
 * generate target code before that happens.
 *
 * An entry module may also be a program: a body of statements that run. The
 * statements are not contracted, so the phase hands them back as they were
 * parsed, and the build compiles every exported function of the program and
 * emits a driver that runs the body.
 *
 * Contracts are target independent and frozen on the way out: a backend reads
 * the program contract, it cannot rewrite it.
 *
 * Files are read through the `read` callback the caller supplies, so this phase
 * never touches the file system and a test can contract a program from a map.
 */

import { byName } from "../core/named-record.ts";
import { parseContract } from "./contract.ts";
import type { Frontend, ProgramBody } from "./module.ts";
import { contractPhaseError, offeredValues, readModuleGraph, type ModuleRecord } from "./module-graph.ts";
import { resolveObjects } from "./objects.ts";
import type { TypeTable } from "./typescript-types.ts";
import { programShapes } from "./program-objects.ts";
import type { LiteralKeys } from "./program-objects.ts";
import { resolveCalls } from "./calls.ts";
import type {
  ContractEdge,
  FileContract,
  FunctionContract,
  ObjectLayout,
  ProgramContract,
  SourceInput,
  SourceModule,
} from "../core/types.ts";

/** The path a source given inline to a project file is known by. */
export { INLINE_MODULE } from "./module-graph.ts";

export interface ContractPhaseRequest {
  frontend: Frontend;
  input: SourceInput;
  /** The entry module, with the path the project knows it by. */
  entry: SourceModule;
  /** Reads an imported module by project-relative path; null when there is none. */
  read: (path: string) => string | null;
}

export interface ContractPhase {
  /** The validated contract graph. Frozen: backends may not change it. */
  program: ProgramContract;
  /** Every module of the program, entry first, in discovery order. */
  modules: SourceModule[];
  /** The statements of the entry module, when it is a program rather than a library. */
  body?: ProgramBody;
  /**
   * The name each object the program writes is laid out as, by the shape of
   * the literal that writes it. The IR of a function body reads this to name
   * the layout of every object the body writes.
   */
  objectNames: Record<string, string>;
  /**
   * The layout of every object the program lays out, by the name it is laid
   * out as. A function definition carries the same record for the IR that
   * describes its body; this is where a program whose entry is statements
   * rather than functions reads the layouts its own literals are built at.
   */
  objectLayouts: Record<string, ObjectLayout>;
  /**
   * The shape key every object literal of the program body was laid out at, by
   * the literal itself. Which of two shapes folded into which one is decided
   * once the whole program has been walked, so the resolver reads the shape of
   * a literal off this rather than deriving one from the parse tree and getting
   * it wrong for a shape that folded.
   */
  objectKeys: LiteralKeys;
}

/* -------------------------------------------------------------------------- */
/* Contract generation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The contracts of one file. A file offers what it exports, and the entry
 * module of a program offers every function it declares, because the program
 * runs them whether or not it exports them.
 */
function contractFile(request: ContractPhaseRequest, record: ModuleRecord, isProgram: boolean): FileContract {
  const entries: (readonly [string, FunctionContract])[] = [];
  const declaredNames = new Set<string>();
  for (const declared of record.analysis.functions) {
    if (!declared.exported && !isProgram && declared.internal !== true) continue;
    if (declaredNames.has(declared.name)) {
      throw contractPhaseError(`${record.path} declares "${declared.name}" more than once`);
    }
    // A malformed contract fails here, before a backend is ever asked for code.
    const contract = request.frontend.contractFor(record.analysis, declared, request.input);
    parseContract(contract);
    declaredNames.add(declared.name);
    entries.push([declared.name, contract]);
  }
  return { path: record.path, functions: byName(entries), imports: [...record.resolved] };
}

/* -------------------------------------------------------------------------- */
/* Cross-file validation                                                       */
/* -------------------------------------------------------------------------- */

/** One name an importing file binds to a function another file declares. */
interface ImportBinding {
  /** The importing file. */
  from: string;
  /** The file the import names. */
  to: string;
  /** The name the exporting file declares. */
  imported: string;
  /** The name the importing file writes. */
  local: string;
}

/**
 * Resolves every import to the symbols it binds, and refuses a program whose
 * files disagree about what exists.
 */
function validateImports(
  records: ModuleRecord[],
  contracts: Map<string, FileContract>,
): { edges: ContractEdge[]; bindings: ImportBinding[] } {
  const analyses: Record<string, string | null> = {};
  const internal: Record<string, Set<string>> = {};
  for (const record of records) {
    analyses[record.path] = record.analysis.default;
    internal[record.path] = new Set(record.analysis.functions.filter((entry) => entry.internal === true).map((entry) => entry.name));
  }
  const edges: ContractEdge[] = [];
  const bindings: ImportBinding[] = [];
  const offeredValuesByPath = offeredValues(records);
  for (const record of records) {
    const declaredHere = new Set(record.analysis.functions.filter((entry) => entry.exported).map((entry) => entry.name));
    const bound = new Map<string, { specifier: string; to: string }>();
    for (const [index, entry] of record.analysis.imports.entries()) {
      const to = record.resolved[index];
      // A host module is the boundary the build links against, not a file of
      // the program: it has no contract of its own, and what the name answers
      // is the native adapter's.
      if (to === "") continue;
      const target = contracts.get(to) as FileContract;
      // A module offers the functions it exports and the values it declares at
      // the top of the file: a name bound to a value is a name this file may
      // import, and what crosses the link is the value itself.
      const named = offeredValuesByPath.find((one) => one.path === to);
      const available = Object.keys(target.functions).filter((name) => internal[to]?.has(name) !== true);
      // A name the module exports is offered even where its value is not one
      // the read settles in place: the import resolves to the name.
      const targetRecord = records.find((one) => one.path === to);
      for (const name of targetRecord?.analysis.exportedNames ?? []) {
        if (!available.includes(name)) available.push(name);
      }
      available.splice(0, available.length, ...new Set(available));
      if (named !== undefined) for (const name of named.values.keys()) available.push(name);
      // A file that re-exports another module's names offers those names: the
      // function is compiled by the module that declares it, and the link
      // reaches it by the name the re-export wrote.
      const reexporting = records.find((one) => one.path === to);
      for (const entry of reexporting?.analysis.reexports ?? []) available.push(...entry.names);
      if (available.length === 0) {
        throw contractPhaseError(`${record.path} imports "${entry.specifier}" (line ${entry.line}), which exports nothing`);
      }
      // A default import names no export of its own: it binds whatever the
      // module it names exports as its default, under the name that function
      // was declared with, because a program of this subset links by name.
      let names = entry.names ?? available;
      if (entry.default) {
        const offered = analyses[to] ?? null;
        if (offered === null) {
          throw contractPhaseError(
            `${record.path} imports the default export of "${entry.specifier}" (line ${entry.line}), which has none`,
            `${to} exports: ${available.join(", ")}; write \`export default function ${available[0]}(...)\` to offer one`,
          );
        }
        // `import d, { a }` binds the default and the names beside it, so the
        // default joins the list rather than standing in for it.
        names = [...names, offered];
      }
      // A rename imports one name and binds another: the module that offers
      // it is asked for the imported name, and the file writes the local one.
      const importedNames = [...names];
      const localNames = names.map((name) => {
        const rename = (entry.renames ?? []).find((one) => one.imported === name);
        return rename === undefined ? name : rename.local;
      });
      for (const rename of entry.renames ?? []) {
        if (!localNames.includes(rename.local)) localNames.push(rename.local);
      }
      // The name a file writes and the name it imports are the same unless a
      // rename binds one to the other; the link needs both.
      const localToImported = new Map<string, string>();
      localNames.forEach((local, at) => localToImported.set(local, importedNames[at] ?? local));
      for (const rename of entry.renames ?? []) localToImported.set(rename.local, rename.imported);
      const missing = importedNames.filter((name) => !available.includes(name));
      if (missing.length > 0) {
        throw contractPhaseError(
          `${record.path} imports ${missing.map((name) => `"${name}"`).join(", ")} from "${entry.specifier}", which does not export ${missing.length === 1 ? "it" : "them"}`,
          `${to} exports: ${available.join(", ")}`,
        );
      }
      for (const name of localNames) {
        const first = bound.get(name);
        // The same module reached twice binds the same name to the same thing,
        // so it is not a collision. Reporting one refused a file that names
        // its imports in more than one statement, or imports a module and
        // includes it.
        if (first !== undefined && first.to !== to) {
          throw contractPhaseError(`${record.path} imports "${name}" from both "${first.specifier}" and "${entry.specifier}"`);
        }
        if (declaredHere.has(name)) {
          throw contractPhaseError(`${record.path} imports "${name}" and declares it itself`);
        }
        bound.set(name, { specifier: entry.specifier, to });
        bindings.push({ from: record.path, to, imported: localToImported.get(name) ?? name, local: name });
      }
      if (!edges.some((edge) => edge.from === record.path && edge.to === to)) {
        edges.push({ from: record.path, to, symbols: importedNames });
      }
    }
  }
  return { edges, bindings };
}

/**
 * The symbol a function is linked under when its file has to make it unique.
 *
 * A program links by symbol, and two files may each write a private helper of
 * the same name. The source name stays the contract's name and the IR's; the
 * symbol is the link's, and a symbol a file makes unique is the file's path
 * with its separators written as underscores, a separator of its own, and the
 * name the source gave it. A path is unique, so the symbol is, unless the
 * sanitized spelling of two paths is one: the counter beside it is the second
 * one of that spelling the program reaches.
 */
function qualifiedSymbol(path: string, name: string, taken: ReadonlySet<string>): string {
  const pathPart = path.replace(/[^A-Za-z0-9_]/g, "_");
  let candidate = `${pathPart}__${name}`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${pathPart}__${name}__${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * The function an importing file's local name reaches, following the module a
 * file re-exports through when the function is another file's.
 */
function targetFunction(
  records: readonly ModuleRecord[],
  contracts: ReadonlyMap<string, FileContract>,
  path: string,
  name: string,
  seen: Set<string> = new Set(),
): FunctionContract | null {
  if (seen.has(path)) return null;
  seen.add(path);
  const direct = contracts.get(path)?.functions[name];
  if (direct !== undefined) return direct;
  const record = records.find((one) => one.path === path);
  if (record === undefined) return null;
  for (const [index, entry] of record.analysis.imports.entries()) {
    if (entry.names != null && !entry.names.includes(name)) continue;
    const to = record.resolved[index];
    if (to === "" || to === path) continue;
    const found = targetFunction(records, contracts, to, name, seen);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Writes the symbol of every call into the body, so the link names the
 * function the call reaches rather than the name the source wrote. A call to
 * a name the program does not compile — a builtin, a runtime service, a value
 * a later pass moves — is left alone.
 */
function rewriteCallsIn(node: unknown, names: ReadonlyMap<string, string>): void {
  if (Array.isArray(node)) {
    for (const value of node) rewriteCallsIn(value, names);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  // A function's body writes a call as an expression; a program's statements
  // write one as an invocation. Both name the function by the name the source
  // gave it, and the link needs the symbol it was given here.
  if (record.k === "call" && typeof record.name === "string") {
    const symbol = names.get(record.name);
    if (symbol !== undefined) record.name = symbol;
  }
  // A program value writes a call of a function by name rather than by callee
  // expression, and the link still needs the symbol.
  if (record.k === "call" && typeof record.function === "string") {
    const symbol = names.get(record.function);
    if (symbol !== undefined) record.function = symbol;
  }
  if (record.kind === "invoke" && typeof record.function === "string") {
    const symbol = names.get(record.function);
    if (symbol !== undefined) record.function = symbol;
  }
  // A call written where a value goes is an invocation of a callee expression,
  // and a callee the source named is an identifier.
  if (record.k === "invoke" && typeof record.callee === "object" && record.callee !== null) {
    const callee = record.callee as Record<string, unknown>;
    if (callee.k === "ident" && typeof callee.name === "string") {
      const symbol = names.get(callee.name);
      if (symbol !== undefined) callee.name = symbol;
    }
  }
  for (const value of Object.values(record)) rewriteCallsIn(value, names);
}

/**
 * Gives every function whose symbol another function already owns a symbol
 * its file makes unique, and writes that symbol into every call of it.
 *
 * A program links by symbol, so one symbol may belong to one function. Two
 * files may each write a private helper of the same name — the compiler's own
 * sources do — and the source name stays the contract's name; what changes is
 * the symbol the link uses. The calls are rewritten here, once, because every
 * later pass reads call names as the symbols they link by: the object pass, the
 * outline that decides which calls are written out, and the IR.
 *
 * A program body is part of the entry file, so it is rewritten with that
 * file's names and reaches the same functions the file's own functions do.
 */
function qualifySymbols(
  records: readonly ModuleRecord[],
  contracts: ReadonlyMap<string, FileContract>,
  bindings: readonly ImportBinding[],
  body: ProgramBody | undefined,
): void {
  const functions: { path: string; name: string; contract: FunctionContract }[] = [];
  for (const record of records) {
    const file = contracts.get(record.path);
    if (file === undefined) continue;
    for (const [name, contract] of Object.entries(file.functions)) functions.push({ path: record.path, name, contract });
  }
  const bySymbol = new Map<string, typeof functions>();
  for (const one of functions) {
    const group = bySymbol.get(one.contract.function.symbol);
    if (group === undefined) bySymbol.set(one.contract.function.symbol, [one]);
    else group.push(one);
  }
  const taken = new Set(functions.map((one) => one.contract.function.symbol));
  for (const [symbol, group] of bySymbol) {
    if (group.length < 2) continue;
    taken.delete(symbol);
    for (const one of group) {
      const unique = qualifiedSymbol(one.path, one.name, taken);
      taken.add(unique);
      one.contract.function.symbol = unique;
    }
  }
  for (const record of records) {
    const file = contracts.get(record.path);
    if (file === undefined) continue;
    const names = new Map<string, string>();
    for (const contract of Object.values(file.functions)) {
      names.set(contract.function.name, contract.function.symbol);
    }
    for (const binding of bindings) {
      if (binding.from !== record.path) continue;
      const target = targetFunction(records, contracts, binding.to, binding.imported);
      if (target !== null) names.set(binding.local, target.function.symbol);
    }
    for (const contract of Object.values(file.functions)) rewriteCallsIn(contract.definition.statements, names);
    if (body !== undefined && body.file === record.path) rewriteCallsIn(body.statements, names);
  }
}

/**
 * A symbol a failed qualification would leave behind is a link step that fails
 * after every source was read: the pass above makes the symbols unique, and this
 * check is the net that says so.
 */
function validateFunctionNames(files: readonly FileContract[]): void {
  const owner = new Map<string, string>();
  for (const file of files) {
    for (const contract of Object.values(file.functions)) {
      const symbol = contract.function.symbol;
      const previous = owner.get(symbol);
      if (previous !== undefined) {
        throw contractPhaseError(
          `"${symbol}" is declared by both ${previous} and ${file.path}`,
          "every function of a program is compiled on its own and linked by its symbol, so one symbol may belong to one function; rename one of them, or import one of them under another name",
        );
      }
      owner.set(symbol, file.path);
    }
  }
}

/** The entry a build compiles: a program body, or an export of the entry file. */
function resolveEntry(
  input: SourceInput,
  entryFile: FileContract,
  body: ProgramBody | undefined,
  internal: ReadonlySet<string>,
): { file: string; function: string | null } {
  const available = Object.keys(entryFile.functions).filter((name) => !internal.has(name));
  const requested = input.entry;
  if (body !== undefined) {
    if (requested !== undefined && requested !== "") {
      throw contractPhaseError(
        `entry "${requested}" names a function, but ${entryFile.path} is a program`,
        "a program is the statements of its entry module: drop \"entry\", and every function it calls is compiled",
      );
    }
    return { file: entryFile.path, function: null };
  }
  // The entry is resolved the same way whether it was named or taken as the
  // first export. A function that states no postcondition was refused when it
  // was named, and letting the default path past the check delivered an
  // implementation nothing had verified, because in a library build there is
  // no program to check it.
  const name = requested === undefined || requested === "" ? available[0] : requested;
  if (name === undefined) {
    throw contractPhaseError(
      `${entryFile.path} exports no function`,
      "the entry module must export the function to compile, or be a program that calls the functions it does export",
    );
  }
  const chosen = entryFile.functions[name];
  if (chosen === undefined) {
    throw contractPhaseError(
      `entry "${name}" is not an export of ${entryFile.path}`,
      `exports: ${available.join(", ")}`,
    );
  }
  if (chosen.ensures.length === 0) {
    throw contractPhaseError(
      `${name} is a function whose contract states no postcondition`,
      "nothing can check such a function on its own: build the module as a program, and the program is compared against its own toolchain",
    );
  }
  return { file: entryFile.path, function: name };
}

/**
 * The body of the program: the statements of the entry module. Only the entry
 * module runs, so a body anywhere else is code that would never run.
 */
function resolveBody(records: ModuleRecord[], entryPath: string): ProgramBody | undefined {
  let body: ProgramBody | undefined;
  for (const record of records) {
    if (record.analysis.body.length === 0) continue;
    if (record.path !== entryPath) {
      // The guard that names the entry module runs nowhere else, so a module
      // the program merely imports holds nothing that runs: it is a library of
      // functions whatever its guard says.
      if (record.analysis.entryGuard === true) continue;
      throw contractPhaseError(
        `${record.path} runs code at the top level`,
        `line ${record.analysis.body[0].line}: only the entry module ${entryPath} runs; a file the program imports is a library of functions`,
      );
    }
    body = {
      file: record.path,
      statements: record.analysis.body,
      ...(record.analysis.wideBigint === true ? { wideBigint: true } : {}),
    };
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function runContractPhase(request: ContractPhaseRequest): ContractPhase {
  const records = readModuleGraph({ ...request, modules: request.input.modules });
  const body = resolveBody(records, request.entry.path);
  const contracts = new Map<string, FileContract>();
  for (const record of records) {
    const file = contractFile(request, record, record.path === request.entry.path && body !== undefined);
    // A file of declarations is a library whether it declares a function, a
    // type or a value. A module that only writes interfaces is reached by the
    // type imports of the files that name them, and a module that only writes
    // constants is reached by the imports that read them: neither offers
    // anything to link, and both offer something to the file that names them.
    const declaredTypes = record.analysis.types?.declarations.size ?? 0;
    const offered = record.analysis.constants as ReadonlyMap<string, unknown> | undefined;
    const declaredValues = offered === undefined ? 0 : offered.size;
    // A file that only re-exports offers the names another module writes: it
    // compiles nothing, and a file that imports one of them reaches the
    // function the other module declared.
    const declaredReexports = (record.analysis.reexports ?? []).reduce((count, entry) => count + entry.names.length, 0);
    if (Object.keys(file.functions).length === 0 && declaredTypes === 0 && declaredValues === 0 && declaredReexports === 0 && !(record.path === request.entry.path && body !== undefined)) {
      throw contractPhaseError(`${record.path} exports no function`, "every file of the program must export what it offers");
    }
    contracts.set(record.path, file);
  }
  const { edges, bindings } = validateImports(records, contracts);
  const files = records.map((record) => contracts.get(record.path) as FileContract);
  // The contract phase names every function and every call before the object
  // pass walks the bodies, because a call is a link edge and a link edge is a
  // symbol.
  qualifySymbols(records, contracts, bindings, body);
  validateFunctionNames(files);
  // The objects a program allocates are named once for the whole program,
  // because a field is often what another function returns. A program body
  // writes objects of its own beside the ones the functions write, so its
  // literals are merged into the same shapes before any name is handed out.
  // The types each module declares are what says what a field of a reference
  // holds: a contract spells a record as the opaque reference, and the layout
  // pass reads the fields through the declaration.
  const types = new Map<string, TypeTable>();
  for (const record of records) {
    if (record.analysis.types !== undefined) types.set(record.path, record.analysis.types);
  }
  const objects =
    resolveObjects(files, body === undefined ? undefined : programShapes(body), types);
  const objectNames = objects.names;
  // Which of the calls that pass recorded is written out rather than made is
  // a property of the whole graph, so it is decided here, once the graph is
  // complete and before anything is generated from it.
  resolveCalls(files);
  const entryRecord = records.find((record) => record.path === request.entry.path);
  const internalEntry = new Set(
    (entryRecord?.analysis.functions ?? []).filter((entry) => entry.internal === true).map((entry) => entry.name),
  );
  const program: ProgramContract = {
    version: "1",
    language: request.input.language,
    entry: resolveEntry(request.input, contracts.get(request.entry.path) as FileContract, body, internalEntry),
    files,
    edges,
  };
  freeze(program);
  return {
    program,
    modules: records.map((record) => ({ path: record.path, source: record.source })),
    objectNames: Object.fromEntries(objectNames),
    objectLayouts: objects.layouts,
    objectKeys: objects.keys,
    ...(body === undefined ? {} : { body }),
  };
}

/** The contract of the function a build compiles. A program has no such function. */
export function entryContract(program: ProgramContract): FunctionContract {
  const file = program.files.find((entry) => entry.path === program.entry.file);
  if (file === undefined) {
    throw contractPhaseError(`the program contract has no file ${program.entry.file}`);
  }
  if (program.entry.function === null) {
    throw contractPhaseError(
      `${program.entry.file} is a program, not a function`,
      "a program compiles every function of the contract graph; ask the build for those, not for an entry",
    );
  }
  const contract = file.functions[program.entry.function];
  if (contract === undefined) {
    throw contractPhaseError(
      `${program.entry.file} exports no "${program.entry.function}"`,
      `exports: ${Object.keys(file.functions).join(", ")}`,
    );
  }
  return contract;
}

/** Contracts are read by backends, so a backend that writes to one fails. */
function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const entry of Object.values(value)) freeze(entry);
}

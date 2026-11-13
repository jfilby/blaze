function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

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
import { freezeValue } from "../core/platform.ts";
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
  /** The file a build reads in place of one the project holds, by path. */
  host?: Readonly<Record<string, string>>;
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
  const entries = new Map<string, FunctionContract>();
  const declaredNames = new Set<string>();
  const filePath = String(fieldOf(record, "path"));
  const analysis = fieldOf(record, "analysis");
  const frontend = fieldOf(request, "frontend");
  const input = fieldOf(request, "input");
  for (const declared of fieldOf(analysis, "functions") as { name: string; exported: boolean; internal?: boolean }[]) {
    const declaredName = String(fieldOf(declared, "name"));
    if (fieldOf(declared, "exported") !== true && !isProgram && fieldOf(declared, "internal") !== true) continue;
    if (declaredNames.has(declaredName)) {
      throw contractPhaseError(`${filePath} declares "${declaredName}" more than once`);
    }
    // A malformed contract fails here, before a backend is ever asked for code.
    const contract = fieldOf(frontend, "contractFor")(analysis, declared, input) as FunctionContract;
    parseContract(contract);
    declaredNames.add(declaredName);
    entries.set(declaredName, contract);
  }
  const imports = fieldOf(record, "resolved") as string[];
  return { path: filePath, functions: byName(entries), imports };
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
    const recordPath = String(fieldOf(record, "path"));
    const analysis = fieldOf(record, "analysis");
    analyses[recordPath] = fieldOf(analysis, "default") as string | null;
    const functions = fieldOf(analysis, "functions") as { name: string; internal?: boolean }[];
    internal[recordPath] = new Set(functions.filter((entry) => fieldOf(entry, "internal") === true).map((entry) => String(fieldOf(entry, "name"))));
  }
  const edges: ContractEdge[] = [];
  const bindings: ImportBinding[] = [];
  const offeredValuesByPath = offeredValues(records);
  for (const record of records) {
    const recordPath = String(fieldOf(record, "path"));
    const analysis = fieldOf(record, "analysis");
    const functions = fieldOf(analysis, "functions") as { name: string; exported: boolean }[];
    const declaredHere = new Set(functions.filter((entry) => fieldOf(entry, "exported") === true).map((entry) => String(fieldOf(entry, "name"))));
    const bound = new Map<string, { specifier: string; to: string }>();
    const imports = fieldOf(analysis, "imports") as unknown[];
    const resolved = fieldOf(record, "resolved") as string[];
    for (const [index, entry] of imports.entries()) {
      const to = String(resolved[index] ?? "");
      const specifier = String(fieldOf(entry, "specifier"));
      const line = fieldOf(entry, "line") as number;
      // A host module is the boundary the build links against, not a file of
      // the program: it has no contract of its own, and what the name answers
      // is the native adapter's.
      if (to === "") continue;
      const target = contracts.get(to) as FileContract;
      // A module offers the functions it exports and the values it declares at
      // the top of the file: a name bound to a value is a name this file may
      // import, and what crosses the link is the value itself.
      const named = offeredValuesByPath.find((one) => String(fieldOf(one, "path")) === to);
      const targetFunctions = fieldOf(target, "functions") as Record<string, unknown>;
      const available = Object.keys(targetFunctions).filter((name) => internal[to]?.has(name) !== true);
      // A name the module exports is offered even where its value is not one
      // the read settles in place: the import resolves to the name.
      const targetRecord = records.find((one) => String(fieldOf(one, "path")) === to);
      if (targetRecord !== undefined) {
        const targetAnalysis = fieldOf(targetRecord, "analysis");
        for (const name of (fieldOf(targetAnalysis, "exportedNames") as string[] | undefined) ?? []) {
          if (!available.includes(name)) available.push(name);
        }
      }
      const unique: string[] = [];
      for (const name of available) if (!unique.includes(name)) unique.push(name);
      available.length = 0;
      for (const name of unique) available.push(name);
      if (named !== undefined) {
        for (const name of (fieldOf(named, "values") as Map<string, unknown>).keys()) available.push(name);
      }
      // A file that re-exports another module's names offers those names: the
      // function is compiled by the module that declares it, and the link
      // reaches it by the name the re-export wrote.
      const reexporting = records.find((one) => String(fieldOf(one, "path")) === to);
      if (reexporting !== undefined) {
        const reexportAnalysis = fieldOf(reexporting, "analysis");
        for (const one of (fieldOf(reexportAnalysis, "reexports") as { names: string[] }[] | undefined) ?? []) {
          for (const name of fieldOf(one, "names") as string[]) available.push(name);
        }
      }
      if (available.length === 0) {
        throw contractPhaseError(`${recordPath} imports "${specifier}" (line ${line}), which exports nothing`);
      }
      // A default import names no export of its own: it binds whatever the
      // module it names exports as its default, under the name that function
      // was declared with, because a program of this subset links by name.
      let names = (fieldOf(entry, "names") as string[] | undefined) ?? available;
      if (fieldOf(entry, "default") === true) {
        const offered = analyses[to] ?? null;
        if (offered === null) {
          throw contractPhaseError(
            `${recordPath} imports the default export of "${specifier}" (line ${line}), which has none`,
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
      const renames = (fieldOf(entry, "renames") as { imported: string; local: string }[] | undefined) ?? [];
      const localNames = names.map((name) => {
        const rename = renames.find((one) => String(fieldOf(one, "imported")) === name);
        return rename === undefined ? name : String(fieldOf(rename, "local"));
      });
      for (const rename of renames) {
        const local = String(fieldOf(rename, "local"));
        if (!localNames.includes(local)) localNames.push(local);
      }
      // The name a file writes and the name it imports are the same unless a
      // rename binds one to the other; the link needs both.
      const localToImported = new Map<string, string>();
      localNames.forEach((local, at) => localToImported.set(local, importedNames[at] ?? local));
      for (const rename of renames) {
        localToImported.set(String(fieldOf(rename, "local")), String(fieldOf(rename, "imported")));
      }
      const missing = importedNames.filter((name) => !available.includes(name));
      if (missing.length > 0) {
        throw contractPhaseError(
          `${recordPath} imports ${missing.map((name) => `"${name}"`).join(", ")} from "${specifier}", which does not export ${missing.length === 1 ? "it" : "them"}`,
          `${to} exports: ${available.join(", ")}`,
        );
      }
      for (const name of localNames) {
        const first = bound.get(name);
        // The same module reached twice binds the same name to the same thing,
        // so it is not a collision. Reporting one refused a file that names
        // its imports in more than one statement, or imports a module and
        // includes it.
        if (first !== undefined && String(fieldOf(first, "to")) !== to) {
          throw contractPhaseError(`${recordPath} imports "${name}" from both "${String(fieldOf(first, "specifier"))}" and "${specifier}"`);
        }
        if (declaredHere.has(name)) {
          throw contractPhaseError(`${recordPath} imports "${name}" and declares it itself`);
        }
        bound.set(name, { specifier, to });
        bindings.push({ from: recordPath, to, imported: localToImported.get(name) ?? name, local: name });
      }
      if (!edges.some((edge) => String(fieldOf(edge, "from")) === recordPath && String(fieldOf(edge, "to")) === to)) {
        edges.push({ from: recordPath, to, symbols: importedNames });
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
  const directContract = contracts.get(path);
  const directFunctions = directContract === undefined
    ? undefined
    : fieldOf(directContract, "functions") as Record<string, FunctionContract>;
  const direct = directFunctions === undefined ? undefined : directFunctions[name];
  if (direct !== undefined) return direct;
  // A value the module holds is linked through the getter the module wrote for
  // it: the value's name is what an importing file writes, and the getter's
  // symbol is what the call becomes.
  const record = records.find((one) => String(fieldOf(one, "path")) === path);
  if (record === undefined) return null;
  const analysis = fieldOf(record, "analysis");
  const getters = fieldOf(analysis, "valueGetters") as Map<string, string> | undefined;
  const getterName = getters === undefined ? undefined : getters.get(name);
  if (getterName !== undefined) {
    const getterContract = contracts.get(path);
    const getterFunctions = getterContract === undefined
      ? undefined
      : fieldOf(getterContract, "functions") as Record<string, FunctionContract>;
    const getter = getterFunctions === undefined ? undefined : getterFunctions[getterName];
    if (getter !== undefined) return getter;
  }
  const imports = fieldOf(analysis, "imports") as unknown[];
  const resolved = fieldOf(record, "resolved") as string[];
  for (const [index, entry] of imports.entries()) {
    const entryNames = fieldOf(entry, "names") as string[] | undefined;
    if (entryNames != null && !entryNames.includes(name)) continue;
    const to = String(resolved[index] ?? "");
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
  if (record["k"] === "call" && typeof record["name"] === "string") {
    const symbol = names.get(record["name"]);
    if (symbol !== undefined) record["name"] = symbol;
  }
  // A program value writes a call of a function by name rather than by callee
  // expression, and the link still needs the symbol.
  if (record["k"] === "call" && typeof record["function"] === "string") {
    const symbol = names.get(record["function"]);
    if (symbol !== undefined) record["function"] = symbol;
  }
  if (record["kind"] === "invoke" && typeof record["function"] === "string") {
    const symbol = names.get(record["function"]);
    if (symbol !== undefined) record["function"] = symbol;
  }
  // A call written where a value goes is an invocation of a callee expression,
  // and a callee the source named is an identifier.
  if (record["k"] === "invoke" && typeof record["callee"] === "object" && record["callee"] !== null) {
    const callee = record["callee"] as Record<string, unknown>;
    if (callee["k"] === "ident" && typeof callee["name"] === "string") {
      const symbol = names.get(callee["name"]);
      if (symbol !== undefined) callee["name"] = symbol;
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
  const signatureOf = (contract: FunctionContract): unknown => fieldOf(contract, "function");
  const symbolOf = (contract: FunctionContract): string => String(fieldOf(signatureOf(contract), "symbol"));
  const functions: { path: string; name: string; contract: FunctionContract }[] = [];
  for (const record of records) {
    const recordPath = String(fieldOf(record, "path"));
    const file = contracts.get(recordPath);
    if (file === undefined) continue;
    for (const [name, contract] of Object.entries(fieldOf(file, "functions") as Record<string, FunctionContract>)) {
      functions.push({ path: recordPath, name, contract });
    }
  }
  const bySymbol = new Map<string, typeof functions>();
  for (const one of functions) {
    const symbol = symbolOf(fieldOf(one, "contract") as FunctionContract);
    const group = bySymbol.get(symbol);
    if (group === undefined) bySymbol.set(symbol, [one]);
    else group.push(one);
  }
  const taken = new Set(functions.map((one) => symbolOf(fieldOf(one, "contract") as FunctionContract)));
  for (const [symbol, group] of bySymbol) {
    if (group.length < 2) continue;
    taken.delete(symbol);
    for (const one of group) {
      const unique = qualifiedSymbol(String(fieldOf(one, "path")), String(fieldOf(one, "name")), taken);
      taken.add(unique);
      const signature = fieldOf(fieldOf(one, "contract") as FunctionContract, "function") as Record<string, unknown>;
      signature["symbol"] = unique;
    }
  }
  for (const record of records) {
    const recordPath = String(fieldOf(record, "path"));
    const file = contracts.get(recordPath);
    if (file === undefined) continue;
    const names = new Map<string, string>();
    for (const contract of Object.values(fieldOf(file, "functions") as Record<string, FunctionContract>)) {
      const signature = signatureOf(contract);
      names.set(String(fieldOf(signature, "name")), String(fieldOf(signature, "symbol")));
    }
    for (const binding of bindings) {
      if (String(fieldOf(binding, "from")) !== recordPath) continue;
      const target = targetFunction(records, contracts, String(fieldOf(binding, "to")), String(fieldOf(binding, "imported")), new Set<string>());
      if (target !== null) names.set(String(fieldOf(binding, "local")), symbolOf(target));
    }
    for (const contract of Object.values(fieldOf(file, "functions") as Record<string, FunctionContract>)) {
      rewriteCallsIn(fieldOf(fieldOf(contract, "definition"), "statements"), names);
    }
    if (body !== undefined && String(fieldOf(body, "file")) === recordPath) {
      rewriteCallsIn(fieldOf(body, "statements"), names);
    }
  }
}

/** The calls a module-level value is read and written through. */
const GLOBAL_SLOT_CALLS: ReadonlySet<string> = new Set([
  "blaze_rt_global_get",
  "blaze_rt_global_set",
  "blaze_rt_global_post_inc",
  "blaze_rt_global_post_dec",
]);

/** Every slot a body names, with the literal that names it. */
function eachGlobalSlot(
  node: unknown,
  handle: (literal: Record<string, unknown>, slot: number) => void,
): void {
  if (Array.isArray(node)) {
    for (const value of node) eachGlobalSlot(value, handle);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (record["k"] === "call" && typeof record["name"] === "string" && GLOBAL_SLOT_CALLS.has(record["name"])) {
    const args = record["args"];
    const first = Array.isArray(args) ? args[0] : undefined;
    if (typeof first === "object" && first !== null) {
      const literal = first as Record<string, unknown>;
      if (literal["k"] === "literal" && typeof literal["text"] === "string" && /^[0-9]+$/.test(literal["text"])) {
        handle(literal, Number(literal["text"]));
      }
    }
  }
  for (const value of Object.values(record)) eachGlobalSlot(value, handle);
}

/**
 * The cells a program's modules hold, numbered once for the program.
 *
 * A module numbers its own top-level values from zero, and a compiled program
 * has one array of cells: two files that each count would share the first
 * cell. The contract phase is where the modules meet, so each file's cells are
 * moved past the cells of the files before it: the body and every function of
 * a file are shifted by the same base, and the entry's statements travel with
 * its file.
 */
function shiftGlobalSlots(
  records: readonly ModuleRecord[],
  contracts: ReadonlyMap<string, FileContract>,
  body: ProgramBody | undefined,
): void {
  let base = 0;
  for (const record of records) {
    const recordPath = String(fieldOf(record, "path"));
    const file = contracts.get(recordPath);
    const fileFunctions = file === undefined
      ? []
      : Object.values(fieldOf(file, "functions") as Record<string, FunctionContract>);
    let highest = -1;
    const count = (node: unknown): void => {
      eachGlobalSlot(node, (_literal, slot) => {
        if (slot > highest) highest = slot;
      });
    };
    if (file !== undefined) {
      for (const contract of fileFunctions) count(fieldOf(fieldOf(contract, "definition"), "statements"));
    }
    const ownsBody = body !== undefined && String(fieldOf(body, "file")) === recordPath;
    if (ownsBody) count(fieldOf(body, "statements"));
    const cells = highest + 1;
    if (cells > 0) {
      if (file !== undefined) {
        for (const contract of fileFunctions) {
          eachGlobalSlot(fieldOf(fieldOf(contract, "definition"), "statements"), (literal, slot) => {
            (literal as Record<string, unknown>)["text"] = String(slot + base);
          });
        }
      }
      if (ownsBody) {
        eachGlobalSlot(fieldOf(body, "statements"), (literal, slot) => {
          (literal as Record<string, unknown>)["text"] = String(slot + base);
        });
      }
    }
    base += cells;
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
    const filePath = String(fieldOf(file, "path"));
    for (const contract of Object.values(fieldOf(file, "functions") as Record<string, FunctionContract>)) {
      const symbol = String(fieldOf(fieldOf(contract, "function"), "symbol"));
      const previous = owner.get(symbol);
      if (previous !== undefined) {
        throw contractPhaseError(
          `"${symbol}" is declared by both ${previous} and ${filePath}`,
          "every function of a program is compiled on its own and linked by its symbol, so one symbol may belong to one function; rename one of them, or import one of them under another name",
        );
      }
      owner.set(symbol, filePath);
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
  const functions = fieldOf(entryFile, "functions") as Record<string, FunctionContract>;
  const entryPath = String(fieldOf(entryFile, "path"));
  const available = Object.keys(functions).filter((name) => !internal.has(name));
  const requested = fieldOf(input, "entry") as string | undefined;
  if (body !== undefined) {
    if (requested !== undefined && String(requested) !== "") {
      throw contractPhaseError(
        `entry "${requested}" names a function, but ${entryPath} is a program`,
        "a program is the statements of its entry module: drop \"entry\", and every function it calls is compiled",
      );
    }
    return { file: entryPath, function: null };
  }
  // The entry is resolved the same way whether it was named or taken as the
  // first export. A function that states no postcondition was refused when it
  // was named, and letting the default path past the check delivered an
  // implementation nothing had verified, because in a library build there is
  // no program to check it.
  const name = requested === undefined || String(requested) === "" ? available[0] : String(requested);
  if (name === undefined) {
    throw contractPhaseError(
      `${entryPath} exports no function`,
      "the entry module must export the function to compile, or be a program that calls the functions it does export",
    );
  }
  const chosen = functions[name];
  if (chosen === undefined) {
    throw contractPhaseError(
      `entry "${name}" is not an export of ${entryPath}`,
      `exports: ${available.join(", ")}`,
    );
  }
  if ((fieldOf(chosen, "ensures") as string[]).length === 0) {
    throw contractPhaseError(
      `${name} is a function whose contract states no postcondition`,
      "nothing can check such a function on its own: build the module as a program, and the program is compared against its own toolchain",
    );
  }
  return { file: entryPath, function: name };
}

/**
 * The body of the program: the statements of the entry module. Only the entry
 * module runs, so a body anywhere else is code that would never run.
 */
function resolveBody(records: ModuleRecord[], entryPath: string): ProgramBody | undefined {
  let body: ProgramBody | undefined;
  for (const record of records) {
    const recordPath = String(fieldOf(record, "path"));
    const analysis = fieldOf(record, "analysis");
    const statements = fieldOf(analysis, "body") as { line: number }[];
    if (statements.length === 0) continue;
    if (recordPath !== entryPath) {
      // The guard that names the entry module runs nowhere else, so a module
      // the program merely imports holds nothing that runs: it is a library of
      // functions whatever its guard says.
      if (fieldOf(analysis, "entryGuard") === true) continue;
      throw contractPhaseError(
        `${recordPath} runs code at the top level`,
        `line ${fieldOf(statements[0], "line")}: only the entry module ${entryPath} runs; a file the program imports is a library of functions`,
      );
    }
    body = {
      file: recordPath,
      statements: statements as ProgramBody["statements"],
      ...(fieldOf(analysis, "wideBigint") === true ? { wideBigint: true } : {}),
    };
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function runContractPhase(request: ContractPhaseRequest): ContractPhase {
  const input = fieldOf(request, "input");
  const entry = fieldOf(request, "entry") as SourceModule;
  const records = readModuleGraph({
    frontend: fieldOf(request, "frontend") as Frontend,
    entry,
    read: fieldOf(request, "read") as (path: string) => string | null,
    host: fieldOf(request, "host") as Readonly<Record<string, string>> | undefined,
    modules: fieldOf(input, "modules") as Readonly<Record<string, string>> | undefined,
  });
  const entryPath = String(fieldOf(entry, "path"));
  const body = resolveBody(records, entryPath);
  const contracts = new Map<string, FileContract>();
  for (const record of records) {
    const recordPath = String(fieldOf(record, "path"));
    const analysis = fieldOf(record, "analysis");
    const file = contractFile(request, record, recordPath === entryPath && body !== undefined);
    // A file of declarations is a library whether it declares a function, a
    // type or a value. A module that only writes interfaces is reached by the
    // type imports of the files that name them, and a module that only writes
    // constants is reached by the imports that read them: neither offers
    // anything to link, and both offer something to the file that names them.
    const types = fieldOf(analysis, "types");
    const declaredTypes = types === undefined ? 0 : (fieldOf(types, "declarations") as Map<string, unknown>).size;
    const offered = fieldOf(analysis, "constants") as ReadonlyMap<string, unknown> | undefined;
    const declaredValues = offered === undefined ? 0 : offered.size;
    // A file that only re-exports offers the names another module writes: it
    // compiles nothing, and a file that imports one of them reaches the
    // function the other module declared.
    let declaredReexports = 0;
    for (const one of (fieldOf(analysis, "reexports") as { names: string[] }[] | undefined) ?? []) {
      declaredReexports += (fieldOf(one, "names") as string[]).length;
    }
    // A value the file holds is offered under its name even where what it
    // holds is not a constant the read wrote out.
    const exportedNames = fieldOf(analysis, "exportedNames") as string[] | undefined;
    const declaredNames = exportedNames === undefined ? 0 : exportedNames.length;
    const functions = fieldOf(file, "functions") as Record<string, unknown>;
    if (Object.keys(functions).length === 0 && declaredTypes === 0 && declaredValues === 0 && declaredReexports === 0 && declaredNames === 0 && !(recordPath === entryPath && body !== undefined)) {
      throw contractPhaseError(`${recordPath} exports no function`, "every file of the program must export what it offers");
    }
    contracts.set(recordPath, file);
  }
  const { edges, bindings } = validateImports(records, contracts);
  const files = records.map((record) => contracts.get(String(fieldOf(record, "path"))) as FileContract);
  // The contract phase names every function and every call before the object
  // pass walks the bodies, because a call is a link edge and a link edge is a
  // symbol.
  qualifySymbols(records, contracts, bindings, body);
  validateFunctionNames(files);
  // The cells a module's top-level values live in are the program's, so the
  // files' own numbering is moved past one another before any body is walked.
  shiftGlobalSlots(records, contracts, body);
  // The objects a program allocates are named once for the whole program,
  // because a field is often what another function returns. A program body
  // writes objects of its own beside the ones the functions write, so its
  // literals are merged into the same shapes before any name is handed out.
  // The types each module declares are what says what a field of a reference
  // holds: a contract spells a record as the opaque reference, and the layout
  // pass reads the fields through the declaration.
  const typeTables = new Map<string, TypeTable>();
  for (const record of records) {
    const analysis = fieldOf(record, "analysis");
    const table = fieldOf(analysis, "types") as TypeTable | undefined;
    if (table !== undefined) typeTables.set(String(fieldOf(record, "path")), table);
  }
  const objects =
    resolveObjects(files, body === undefined ? undefined : programShapes(body), typeTables);
  const objectNames = objects.names;
  // Which of the calls that pass recorded is written out rather than made is
  // a property of the whole graph, so it is decided here, once the graph is
  // complete and before anything is generated from it.
  resolveCalls(files);
  const entryRecord = records.find((record) => String(fieldOf(record, "path")) === entryPath);
  const internalEntry = new Set<string>();
  if (entryRecord !== undefined) {
    const entryAnalysis = fieldOf(entryRecord, "analysis");
    for (const one of (fieldOf(entryAnalysis, "functions") as { name: string; internal?: boolean }[] | undefined) ?? []) {
      if (fieldOf(one, "internal") === true) internalEntry.add(String(fieldOf(one, "name")));
    }
  }
  const program: ProgramContract = {
    version: "1",
    language: String(fieldOf(input, "language")),
    entry: resolveEntry(input, contracts.get(entryPath) as FileContract, body, internalEntry),
    files,
    edges,
  };
  freezeValue(program);
  return {
    program,
    modules: records.map((record) => ({ path: String(fieldOf(record, "path")), source: String(fieldOf(record, "source")) })),
    objectNames: Object.fromEntries(objectNames),
    objectLayouts: objects.layouts,
    objectKeys: objects.keys,
    ...(body === undefined ? {} : { body }),
  };
}

/** The contract of the function a build compiles. A program has no such function. */
export function entryContract(program: ProgramContract): FunctionContract {
  const programEntry = fieldOf(program, "entry");
  const entryFile = String(fieldOf(programEntry, "file"));
  const files = fieldOf(program, "files") as FileContract[];
  const file = files.find((entry) => String(fieldOf(entry, "path")) === entryFile);
  if (file === undefined) {
    throw contractPhaseError(`the program contract has no file ${entryFile}`);
  }
  const entryFunction = fieldOf(programEntry, "function") as string | null;
  if (entryFunction === null) {
    throw contractPhaseError(
      `${entryFile} is a program, not a function`,
      "a program compiles every function of the contract graph; ask the build for those, not for an entry",
    );
  }
  const functions = fieldOf(file, "functions") as Record<string, FunctionContract>;
  const contract = functions[entryFunction];
  if (contract === undefined) {
    throw contractPhaseError(
      `${entryFile} exports no "${entryFunction}"`,
      `exports: ${Object.keys(functions).join(", ")}`,
    );
  }
  return contract;
}


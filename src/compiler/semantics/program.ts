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

import { posix } from "node:path";
import { CompilerError } from "../core/errors.ts";
import { parseContract } from "./contract.ts";
import type { Frontend, ModuleAnalysis, ModuleImport, ProgramBody } from "./module.ts";
import type { ContractEdge, FileContract, FunctionContract, ProgramContract, SourceInput, SourceModule } from "../core/types.ts";

/** The path a source given inline to a project file is known by. */
export const INLINE_MODULE = "<inline>";

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
}

function contractPhaseError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "ContractError", stage: "contract", message, detail });
}

/** One file of the program, with where each of its imports landed. */
interface ModuleRecord {
  path: string;
  source: string;
  analysis: ModuleAnalysis;
  /** Resolved import targets, in the order the imports are written. */
  resolved: string[];
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
 * Source analysis: every file the program reaches from its entry, each parsed
 * by the frontend and each import resolved to a file that exists.
 */
function discover(request: ContractPhaseRequest, read: (path: string) => string | null): ModuleRecord[] {
  const records = new Map<string, ModuleRecord>();
  const pending = [request.entry.path];

  while (pending.length > 0) {
    const path = pending.shift() as string;
    if (records.has(path)) continue;
    const source = path === request.entry.path ? request.entry.source : read(path);
    if (source === null) throw contractPhaseError(`cannot read module ${path}`);
    if (source.trim() === "") throw contractPhaseError(`module ${path} is empty`);

    const record: ModuleRecord = { path, source, analysis: request.frontend.analyze(source, path), resolved: [] };
    records.set(path, record);
    for (const entry of record.analysis.imports) {
      const resolved = resolveImport(request, read, path, entry);
      record.resolved.push(resolved);
      pending.push(resolved);
    }
  }

  return [...records.values()];
}

/** The file an import names, resolved against the project, or refused. */
function resolveImport(
  request: ContractPhaseRequest,
  read: (path: string) => string | null,
  from: string,
  entry: ModuleImport,
): string {
  // A project that pastes its source has no directory to resolve against.
  if (from === INLINE_MODULE) {
    throw contractPhaseError(
      `an inline source cannot import "${entry.specifier}"`,
      'set "sourceFile" to a file beside the project file so its imports can be resolved',
    );
  }
  const candidates = request.frontend.resolveImport(entry.specifier).map((candidate) => modulePath(candidate, from));
  const resolved = candidates.find((path) => read(path) !== null);
  if (resolved === undefined) {
    throw contractPhaseError(
      `${from} imports "${entry.specifier}" (line ${entry.line}), which is not a module of this project`,
      `looked for ${candidates.join(", ")}`,
    );
  }
  return resolved;
}

/** Joins a file name an import may name onto the importing file. */
function modulePath(candidate: string, from: string): string {
  return posix.normalize(posix.join(posix.dirname(from), candidate));
}

/* -------------------------------------------------------------------------- */
/* Contract generation                                                         */
/* -------------------------------------------------------------------------- */

/** One contract per exported function of one file. */
function contractFile(request: ContractPhaseRequest, record: ModuleRecord): FileContract {
  const functions: Record<string, FunctionContract> = {};
  for (const declared of record.analysis.functions) {
    if (!declared.exported) continue;
    if (functions[declared.name] !== undefined) {
      throw contractPhaseError(`${record.path} exports "${declared.name}" more than once`);
    }
    // A malformed contract fails here, before a backend is ever asked for code.
    const contract = request.frontend.contractFor(record.analysis, declared, request.input);
    parseContract(contract);
    functions[declared.name] = contract;
  }
  return { path: record.path, functions, imports: [...record.resolved] };
}

/* -------------------------------------------------------------------------- */
/* Cross-file validation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolves every import to the symbols it binds, and refuses a program whose
 * files disagree about what exists.
 */
function validateImports(records: ModuleRecord[], contracts: Map<string, FileContract>): ContractEdge[] {
  const edges: ContractEdge[] = [];
  for (const record of records) {
    const declaredHere = new Set(record.analysis.functions.filter((entry) => entry.exported).map((entry) => entry.name));
    const bound = new Map<string, string>();
    for (const [index, entry] of record.analysis.imports.entries()) {
      const to = record.resolved[index];
      const target = contracts.get(to) as FileContract;
      const available = Object.keys(target.functions);
      if (available.length === 0) {
        throw contractPhaseError(`${record.path} imports "${entry.specifier}" (line ${entry.line}), which exports nothing`);
      }
      const names = entry.names ?? available;
      const missing = names.filter((name) => target.functions[name] === undefined);
      if (missing.length > 0) {
        throw contractPhaseError(
          `${record.path} imports ${missing.map((name) => `"${name}"`).join(", ")} from "${entry.specifier}", which does not export ${missing.length === 1 ? "it" : "them"}`,
          `${to} exports: ${available.join(", ")}`,
        );
      }
      for (const name of names) {
        const first = bound.get(name);
        if (first !== undefined) {
          throw contractPhaseError(`${record.path} imports "${name}" from both "${first}" and "${entry.specifier}"`);
        }
        if (declaredHere.has(name)) {
          throw contractPhaseError(`${record.path} imports "${name}" and declares it itself`);
        }
        bound.set(name, entry.specifier);
      }
      edges.push({ from: record.path, to, symbols: names });
    }
  }
  return edges;
}

/** The entry a build compiles: a program body, or an export of the entry file. */
function resolveEntry(
  input: SourceInput,
  entryFile: FileContract,
  body: ProgramBody | undefined,
): { file: string; function: string | null } {
  const available = Object.keys(entryFile.functions);
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
  if (requested === undefined || requested === "") {
    const first = available[0];
    if (first === undefined) {
      throw contractPhaseError(
        `${entryFile.path} exports no function`,
        "the entry module must export the function to compile, or be a program that calls the functions it does export",
      );
    }
    return { file: entryFile.path, function: first };
  }
  if (entryFile.functions[requested] === undefined) {
    throw contractPhaseError(
      `entry "${requested}" is not an export of ${entryFile.path}`,
      `exports: ${available.join(", ")}`,
    );
  }
  return { file: entryFile.path, function: requested };
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
      throw contractPhaseError(
        `${record.path} runs code at the top level`,
        `line ${record.analysis.body[0].line}: only the entry module ${entryPath} runs; a file the program imports is a library of functions`,
      );
    }
    body = { file: record.path, statements: record.analysis.body };
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function runContractPhase(request: ContractPhaseRequest): ContractPhase {
  const read = cachingReader(request.read);
  const records = discover(request, read);
  const body = resolveBody(records, request.entry.path);
  const contracts = new Map<string, FileContract>();
  for (const record of records) {
    const file = contractFile(request, record);
    if (Object.keys(file.functions).length === 0 && !(record.path === request.entry.path && body !== undefined)) {
      throw contractPhaseError(`${record.path} exports no function`, "every file of the program must export what it offers");
    }
    contracts.set(record.path, file);
  }
  const edges = validateImports(records, contracts);
  const program: ProgramContract = {
    version: "1",
    language: request.input.language,
    entry: resolveEntry(request.input, contracts.get(request.entry.path) as FileContract, body),
    files: records.map((record) => contracts.get(record.path) as FileContract),
    edges,
  };
  freeze(program);
  return {
    program,
    modules: records.map((record) => ({ path: record.path, source: record.source })),
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

/**
 * The compact form a program contract takes on disk.
 *
 * The object pass lays the whole program out once and writes that one table
 * into every function definition (`semantics/objects.ts`). In memory that is
 * one shared object, and the structural hash caches it by identity. JSON has
 * no sharing: written out as it stands, the same table — and the same tag
 * table — is repeated once per function. For a compiler that compiles itself
 * that is thousands of copies of its module graph and a contract file measured
 * in gigabytes.
 *
 * So the disk form keeps the shared tables once, at the program level, and
 * leaves each definition without them. Reading it back writes the one table
 * into every definition again, so every consumer of a contract still sees a
 * self-contained function and needs no change. A contract written before this
 * form has no program-level table and is read as it was.
 */

import type { ProgramContract } from "./types.ts";

type RecordValue = Record<string, unknown>;

/**
 * The definition without the tables the program now carries once. Undefined
 * members are left out of the JSON, so a definition written this way has no
 * objects field until it is read back.
 */
function sharedDefinition(definition: RecordValue): RecordValue {
  return {
    statements: definition["statements"],
    objects: undefined,
    tagLayouts: undefined,
    allocates: definition["allocates"],
    prints: definition["prints"],
    readsArgv: definition["readsArgv"],
    calls: definition["calls"],
  };
}

/**
 * The value written to `contract.json`: the shared layout and tag tables once,
 * and function definitions that name no table of their own.
 *
 * When the functions do not all share one table the program is written as it
 * stands — a per-function table is data, not duplication, and must be kept.
 */
export function compactContract(program: ProgramContract): unknown {
  const top = (program as unknown as RecordValue);
  const files = top["files"] as readonly RecordValue[];
  let objects: unknown = null;
  let tags: unknown = null;
  let seen = false;
  const objectTables = new Set<unknown>();
  const tagTables = new Set<unknown>();

  for (const file of files) {
    const functions = file["functions"] as Record<string, RecordValue>;
    for (const contract of Object.values(functions)) {
      const definition = (contract["definition"] as unknown as RecordValue);
      const ownObjects = definition["objects"];
      const ownTags = definition["tagLayouts"];
      if (!seen) {
        objects = ownObjects;
        tags = ownTags;
        seen = true;
      }
      objectTables.add(ownObjects);
      tagTables.add(ownTags);
    }
  }
  // One distinct table for the whole program is what can be hoisted. A
  // per-function table is data, not duplication, and is written as it was.
  if (!seen || objectTables.size !== 1 || tagTables.size !== 1) return program;

  const compactFiles: RecordValue[] = [];
  for (const file of files) {
    const functions = file["functions"] as Record<string, RecordValue>;
    const compactFunctions: Record<string, RecordValue> = {};
    for (const [name, contract] of Object.entries(functions)) {
      compactFunctions[name] = {
        version: contract["version"],
        function: contract["function"],
        promise: contract["promise"],
        requires: contract["requires"],
        ensures: contract["ensures"],
        memory: contract["memory"],
        effects: contract["effects"],
        numeric: contract["numeric"],
        optimize: contract["optimize"],
        definition: sharedDefinition((contract["definition"] as unknown as RecordValue)),
      };
    }
    compactFiles.push({
      path: file["path"],
      functions: compactFunctions,
      imports: file["imports"],
    });
  }
  return {
    version: top["version"],
    language: top["language"],
    entry: top["entry"],
    files: compactFiles,
    edges: top["edges"],
    objects,
    tagLayouts: tags,
  };
}

/**
 * The contract a stored value denotes. The program-level tables are written
 * back into every definition by identity, so N functions share one table the
 * way they did before the value was written.
 */
export function expandContract(stored: unknown): ProgramContract {
  const top = (stored as unknown as RecordValue);
  // A contract written before the compact form has no program-level table; it
  // already carries its tables in every definition and is read as it was.
  if (!Object.prototype.hasOwnProperty.call(top, "objects")) return stored as ProgramContract;
  const objects = top["objects"];
  const hasTags = Object.prototype.hasOwnProperty.call(top, "tagLayouts");
  const tags = top["tagLayouts"];

  for (const file of top["files"] as RecordValue[]) {
    const functions = file["functions"] as Record<string, RecordValue>;
    for (const contract of Object.values(functions)) {
      const definition = (contract["definition"] as unknown as RecordValue);
      definition["objects"] = objects;
      if (hasTags) definition["tagLayouts"] = tags;
    }
  }
  return stored as ProgramContract;
}

/**
 * A relocatable ELF object, written by the compiler.
 *
 * One function of a program is one object, and the linker is what puts it beside
 * the others: an object carries the code, the read-only data the code reads,
 * the symbols both name, and the places where a distance is not known until the
 * linker has placed everything together. This file is that container and nothing
 * else — it decides no instruction and reads no IR.
 *
 * The shape is the one x86-64 System V takes: a 64 bit little endian
 * relocatable, code in `.text`, literals in `.rodata`, and every address left to
 * the linker as an `R_X86_64_PLT32` or an `R_X86_64_PC32`.
 */

import { CompilerError } from "../core/errors.ts";
import type { Relocation } from "./x86.ts";

/* -------------------------------------------------------------------------- */
/* The format                                                                   */
/* -------------------------------------------------------------------------- */

const ET_REL = 1;
const EM_X86_64 = 62;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const STB_GLOBAL = 1;
const STT_NOTYPE = 0;
const STT_FUNC = 2;
const SHN_UNDEF = 0;

const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;

const ELF_HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 64;
const SYMBOL_SIZE = 24;
const RELOCATION_SIZE = 24;

/* -------------------------------------------------------------------------- */
/* What an object is made of                                                    */
/* -------------------------------------------------------------------------- */

/** One label in the read-only data, which the code takes the address of. */
export interface DataLabel {
  readonly name: string;
  readonly offset: number;
}

/** The one function the object defines, which the program calls by this name. */
export interface DefinedFunction {
  readonly name: string;
  /** Where its code starts in `.text`. */
  readonly offset: number;
  readonly size: number;
}

export interface ObjectRequest {
  readonly text: Uint8Array;
  readonly rodata: Uint8Array;
  readonly function: DefinedFunction;
  readonly labels: readonly DataLabel[];
  /** The symbols the code calls or reads that this object does not define. */
  readonly undefined: readonly string[];
  readonly relocations: readonly Relocation[];
}

export interface ObjectBytes {
  readonly bytes: Uint8Array;
  /** The bytes of code the object carries, which is what a size weighs. */
  readonly textSizeBytes: number;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                     */
/* -------------------------------------------------------------------------- */

/** The sections of the object, in the order they are written. */
const SECTIONS = {
  empty: 0,
  text: 1,
  data: 2,
  relocations: 3,
  symbols: 4,
  strings: 5,
  sectionNames: 6,
  stackNote: 7,
  count: 8,
} as const;

const SECTION_LAYOUT = [
  { key: "empty", name: "", type: 0, flags: 0, align: 0, entrySize: 0 },
  { key: "text", name: ".text", type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, align: 16, entrySize: 0 },
  { key: "data", name: ".rodata", type: SHT_PROGBITS, flags: SHF_ALLOC, align: 8, entrySize: 0 },
  { key: "relocations", name: ".rela.text", type: SHT_RELA, flags: 0, align: 8, entrySize: RELOCATION_SIZE },
  { key: "symbols", name: ".symtab", type: SHT_SYMTAB, flags: 0, align: 8, entrySize: SYMBOL_SIZE },
  { key: "strings", name: ".strtab", type: SHT_STRTAB, flags: 0, align: 1, entrySize: 0 },
  { key: "sectionNames", name: ".shstrtab", type: SHT_STRTAB, flags: 0, align: 1, entrySize: 0 },
  // An empty note of its own: without it a linker takes the stack to be
  // executable, and says so about every object it reads.
  { key: "stackNote", name: ".note.GNU-stack", type: SHT_PROGBITS, flags: SHF_ALLOC, align: 1, entrySize: 0 },
] as const;

/* -------------------------------------------------------------------------- */
/* A string table                                                               */
/* -------------------------------------------------------------------------- */

/** A string table as it is written: every name, each one NUL terminated. */
class StringTable {
  private readonly bytes: number[] = [0];
  private readonly offsets = new Map<string, number>([["", 0]]);

  /** The offset a name is written at, adding it the first time it is asked for. */
  add(name: string): number {
    const known = this.offsets.get(name);
    if (known !== undefined) return known;
    const offset = this.bytes.length;
    for (const character of name) {
      const code = character.codePointAt(0) ?? 0;
      if (code > 0x7f) {
        throw new CompilerError({
          category: "AssemblyError",
          stage: "assemble",
          message: `the symbol name ${JSON.stringify(name)} is not one the object format holds`,
        });
      }
      this.bytes.push(code);
    }
    this.bytes.push(0);
    this.offsets.set(name, offset);
    return offset;
  }

  write(into: Uint8Array, at: number): void {
    into.set(this.bytes, at);
  }

  get size(): number {
    return this.bytes.length;
  }
}

/** One symbol of the object, as the table it is written into. */
interface Symbol {
  readonly name: number;
  readonly section: number;
  readonly value: number;
  readonly size: number;
  readonly info: number;
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                      */
/* -------------------------------------------------------------------------- */

/** The object a function's machine code is written into. */
export function writeObject(request: ObjectRequest): ObjectBytes {
  const sectionNames = new StringTable();
  for (const section of SECTION_LAYOUT) sectionNames.add(section.name);

  // One table of names for every symbol: the format reads a local name out of
  // the same table the section header points at, so a name kept in a table of
  // its own would be read out of the wrong one.
  const names = new StringTable();
  // The table starts with the symbol that names nothing, then the locals, then
  // the rest: the format reads the globals as starting at `sh_info`, so a local
  // written after them would be read as a global.
  const symbols: Symbol[] = [
    { name: 0, section: SHN_UNDEF, value: 0, size: 0, info: 0 },
    { name: 0, section: SECTIONS.text, value: 0, size: 0, info: 0 },
    { name: 0, section: SECTIONS.data, value: 0, size: 0, info: 0 },
  ];
  // A name is written once however many places take its address, so the symbol
  // a relocation names is the one the table already holds.
  const index = new Map<string, number>();
  for (const label of request.labels) {
    index.set(label.name, symbols.length);
    symbols.push({ name: names.add(label.name), section: SECTIONS.data, value: label.offset, size: 0, info: STT_NOTYPE });
  }
  const firstGlobal = symbols.length;
  symbols.push({
    name: names.add(request.function.name),
    section: SECTIONS.text,
    value: request.function.offset,
    size: request.function.size,
    info: (STB_GLOBAL << 4) | STT_FUNC,
  });
  index.set(request.function.name, firstGlobal);
  for (const name of request.undefined) {
    if (index.has(name)) continue;
    index.set(name, symbols.length);
    symbols.push({ name: names.add(name), section: SHN_UNDEF, value: 0, size: 0, info: (STB_GLOBAL << 4) | STT_NOTYPE });
  }
  for (const relocation of request.relocations) {
    if (index.has(relocation.symbol)) continue;
    throw new CompilerError({
      category: "AssemblyError",
      stage: "assemble",
      message: `the machine code refers to ${relocation.symbol}, which the object does not name`,
    });
  }

  const relocationSize = request.relocations.length * RELOCATION_SIZE;
  const textOffset = align(ELF_HEADER_SIZE, 16);
  const dataOffset = align(textOffset + request.text.length, 8);
  const relocationOffset = align(dataOffset + request.rodata.length, 8);
  const symbolOffset = align(relocationOffset + relocationSize, 8);
  const stringOffset = symbolOffset + symbols.length * SYMBOL_SIZE;
  const sectionNameOffset = stringOffset + names.size;
  const headerOffset = align(sectionNameOffset + sectionNames.size, 8);
  const total = headerOffset + SECTIONS.count * SECTION_HEADER_SIZE;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  // The header. A relocatable has no entry point and no program headers: the
  // linker is what turns sections into a program.
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, ET_REL, true);
  view.setUint16(18, EM_X86_64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(headerOffset), true);
  view.setUint16(52, ELF_HEADER_SIZE, true);
  view.setUint16(58, SECTION_HEADER_SIZE, true);
  view.setUint16(60, SECTIONS.count, true);
  view.setUint16(62, SECTIONS.sectionNames, true);

  bytes.set(request.text, textOffset);
  bytes.set(request.rodata, dataOffset);

  // The relocations, each one a place the linker fills an address into. Both
  // kinds are measured from the end of their own field, so the four bytes of
  // the instruction before it are the addend.
  request.relocations.forEach((relocation, at) => {
    const where = relocationOffset + at * RELOCATION_SIZE;
    const symbol = index.get(relocation.symbol) ?? 0;
    const type = relocation.kind === "call" ? R_X86_64_PLT32 : R_X86_64_PC32;
    // The offset is the one inside the section, not a place in the file: a
    // relocatable is a template the linker places, and the section is what it
    // places at an address.
    view.setBigUint64(where, BigInt(relocation.offset), true);
    view.setBigUint64(where + 8, BigInt(symbol) * 0x1_0000_0000n + BigInt(type), true);
    view.setBigInt64(where + 16, -4n, true);
  });

  symbols.forEach((symbol, at) => {
    const where = symbolOffset + at * SYMBOL_SIZE;
    view.setUint32(where, symbol.name, true);
    bytes[where + 4] = symbol.info;
    view.setUint16(where + 6, symbol.section, true);
    view.setBigUint64(where + 8, BigInt(symbol.value), true);
    view.setBigUint64(where + 16, BigInt(symbol.size), true);
  });
  names.write(bytes, stringOffset);
  sectionNames.write(bytes, sectionNameOffset);

  const size: Record<number, number> = {
    [SECTIONS.empty]: 0,
    [SECTIONS.text]: request.text.length,
    [SECTIONS.data]: request.rodata.length,
    [SECTIONS.relocations]: relocationSize,
    [SECTIONS.symbols]: symbols.length * SYMBOL_SIZE,
    [SECTIONS.strings]: names.size,
    [SECTIONS.sectionNames]: sectionNames.size,
    [SECTIONS.stackNote]: 0,
  };
  const at: Record<number, number> = {
    [SECTIONS.empty]: 0,
    [SECTIONS.text]: textOffset,
    [SECTIONS.data]: dataOffset,
    [SECTIONS.relocations]: relocationOffset,
    [SECTIONS.symbols]: symbolOffset,
    [SECTIONS.strings]: stringOffset,
    [SECTIONS.sectionNames]: sectionNameOffset,
    [SECTIONS.stackNote]: 0,
  };
  for (const section of SECTION_LAYOUT) {
    const index2 = SECTIONS[section.key];
    const where = headerOffset + index2 * SECTION_HEADER_SIZE;
    // A relocations section links the symbols it names and carries the section
    // it applies to; a symbol table links the names it writes them out of and
    // says where its globals start.
    const link = section.key === "relocations" ? SECTIONS.symbols : section.key === "symbols" ? SECTIONS.strings : 0;
    const target = section.key === "relocations" ? SECTIONS.text : section.key === "symbols" ? firstGlobal : 0;
    view.setUint32(where, sectionNames.add(section.name), true);
    view.setUint32(where + 4, section.type, true);
    view.setBigUint64(where + 8, BigInt(section.flags), true);
    // The address a section is loaded at is the linker's to decide: an object
    // holds none, so the field stays zero and the offset and the size follow.
    view.setBigUint64(where + 24, BigInt(at[index2]), true);
    view.setBigUint64(where + 32, BigInt(size[index2]), true);
    view.setUint32(where + 40, link, true);
    view.setUint32(where + 44, target, true);
    view.setBigUint64(where + 48, BigInt(section.align), true);
    view.setBigUint64(where + 56, BigInt(section.entrySize), true);
  }
  return { bytes, textSizeBytes: request.text.length };
}

/* -------------------------------------------------------------------------- */
/* Reading one back                                                             */
/* -------------------------------------------------------------------------- */

const SECTION_TYPES: Record<number, string> = {
  [SHT_PROGBITS]: "PROGBITS",
  [SHT_SYMTAB]: "SYMTAB",
  [SHT_STRTAB]: "STRTAB",
  [SHT_RELA]: "RELA",
};

const RELOCATION_TYPES: Record<number, string> = { [R_X86_64_PC32]: "PC32", [R_X86_64_PLT32]: "PLT32" };

interface ReadSection {
  readonly name: string;
  readonly type: string;
  readonly kind: number;
  readonly flags: number;
  readonly offset: number;
  readonly size: number;
  readonly link: number;
  readonly entrySize: number;
}

/**
 * What an object holds, read back out of it rather than remembered. A review of
 * machine code is shown this, so it is what the object says and not a
 * description of what was meant to be written.
 */
export function describeObject(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headersAt = Number(view.getBigUint64(40, true));
  const count = view.getUint16(60, true);
  const sectionNamesOffset = Number(
    view.getBigUint64(headersAt + view.getUint16(62, true) * SECTION_HEADER_SIZE + 24, true),
  );
  const sections: ReadSection[] = Array.from({ length: count }, (_, at) => {
    const where = headersAt + at * SECTION_HEADER_SIZE;
    const kind = view.getUint32(where + 4, true);
    return {
      name: readString(bytes, sectionNamesOffset + view.getUint32(where, true)),
      type: SECTION_TYPES[kind] ?? String(kind),
      kind,
      flags: view.getUint32(where + 8, true),
      offset: Number(view.getBigUint64(where + 24, true)),
      size: Number(view.getBigUint64(where + 32, true)),
      link: view.getUint32(where + 40, true),
      entrySize: Number(view.getBigUint64(where + 56, true)),
    };
  });

  const lines = [
    "ELF64 relocatable, x86-64, System V",
    "",
    "sections:",
    ...sections
      .slice(1)
      .map((section) => `  ${section.name.padEnd(16)} ${section.type.padEnd(8)} ${section.size} bytes  flags 0x${section.flags.toString(16)}`),
    "",
  ];

  const symbolTable = sections.find((section) => section.kind === SHT_SYMTAB);
  if (symbolTable !== undefined) {
    const stringsAt = sections[symbolTable.link].offset;
    const defined: string[] = [];
    const absent: string[] = [];
    for (let at = symbolTable.offset; at < symbolTable.offset + symbolTable.size; at += symbolTable.entrySize) {
      const name = readString(bytes, stringsAt + view.getUint32(at, true));
      if (name === "") continue;
      const line = `${name} at ${view.getBigUint64(at + 8, true)}`;
      (view.getUint16(at + 6, true) === SHN_UNDEF ? absent : defined).push(line);
    }
    lines.push("defines:", ...defined.map((name) => `  ${name}`), "", "refers to:", ...absent.map((name) => `  ${name}`), "");
  }

  const relocations = sections.find((section) => section.kind === SHT_RELA);
  if (relocations !== undefined) {
    const table = sections[relocations.link];
    const stringsAt = sections[table.link].offset;
    const entries: string[] = [];
    for (let at = relocations.offset; at < relocations.offset + relocations.size; at += relocations.entrySize) {
      const info = view.getBigUint64(at + 8, true);
      const symbolAt = table.offset + Number(info / 0x1_0000_0000n) * table.entrySize;
      const type = Number(info & 0xffn);
      entries.push(
        `  text+${Number(view.getBigUint64(at, true))} ${RELOCATION_TYPES[type] ?? String(type)} ${readString(bytes, stringsAt + view.getUint32(symbolAt, true))}`,
      );
    }
    lines.push("relocations:", ...entries, "");
  }
  return lines.join("\n");
}

function readString(bytes: Uint8Array, at: number): string {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return Buffer.from(bytes.subarray(at, end)).toString("latin1");
}

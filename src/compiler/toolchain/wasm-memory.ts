/**
 * The memory plan of a WebAssembly module.
 *
 * A module's linear memory is one artifact. The lowering knows how much wide
 * scratch it needs and which constants it pooled; the host knows where it may
 * hand memory out. Neither may guess the other's numbers, so the compiler
 * makes one plan, from the lowering's measured requirements, and both the
 * module and the host are written from that plan.
 *
 * Regions are half-open `[offset, offset + size)` intervals. They are laid out
 * in order, they are aligned, and they do not overlap. A region's size is
 * derived from a measured requirement, never from a fixed address.
 */

/** The size of a WebAssembly page, which is the unit of a memory's minimum. */
export const WASM_PAGE_SIZE = 65536;

/** The alignment every region boundary is placed on. */
export const WASM_REGION_ALIGNMENT = 16;

/** The header the host writes in front of every block it allocates. */
export const WASM_HOST_HEADER_BYTES = 64;
/** The count word the host writes between the header and the payload. */
export const WASM_HOST_COUNT_BYTES = 8;
/** The bytes before a host pointer that the host may read as a header. */
export const WASM_HOST_OVERHEAD = WASM_HOST_HEADER_BYTES + WASM_HOST_COUNT_BYTES;

/**
 * Bytes kept reserved at address zero.
 *
 * Zero is the host's null and the host reads a header just below every pointer
 * it is handed. A module-owned address must therefore sit above both, or a
 * literal text would be mistaken for a managed one and its header read from
 * before the start of memory. The guard is derived from those two limits.
 */
export const WASM_NULL_GUARD = wasmAlignUp(WASM_HOST_OVERHEAD, WASM_REGION_ALIGNMENT);

/**
 * Pages of working space the host reserves above the module's own memory.
 *
 * This is a requirement of the host's allocator, not an address: it says how
 * much room the runtime has to build the values a program allocates. It is
 * added to the pages the module's data needs to give the plan's capacity.
 */
export const WASM_RUNTIME_PAGES = 4;

/** The names a plan's regions may have. */
export type WasmRegionName = "wide" | "reserved" | "static" | "runtime";

/** One region of the module's memory. */
export interface WasmRegion {
  readonly name: WasmRegionName;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

/**
 * A symbolic reference to an address the lowering writes into a function body.
 *
 * The address is not a number until the plan exists: a static address is an
 * offset into the static data region, and a scratch address is an offset into
 * one function's scratch region. Resolving a reference checks that the address
 * lands inside the region it names.
 */
export interface WasmAddressRef {
  readonly kind: "static" | "scratch";
  /** The function whose scratch is named, for a scratch reference. */
  readonly fn: number;
  /** The offset within the named region. */
  readonly offset: number;
}

/** What lowering measured, which is all the planner is told. */
export interface WasmMemoryRequirements {
  /** The wide scratch each function needs, in the order the functions are numbered. */
  readonly scratchSizes: readonly number[];
  /** The bytes of static data the module pooled, before alignment padding. */
  readonly staticSize: number;
  /** Working pages the host needs, past the pages the module's data needs. */
  readonly runtimePages?: number;
  /** The alignment of every region boundary. */
  readonly alignment?: number;
  /** The reserved bytes at address zero that keep null distinct. */
  readonly guardBytes?: number;
}

/** The finalized plan: the one artifact the module and the host both read. */
export interface WasmMemoryPlan {
  readonly regions: readonly WasmRegion[];
  /** The minimum number of pages the module imports. */
  readonly pages: number;
  /** The pages of host working space above the module's minimum. */
  readonly runtimePages: number;
  /** The pages the host allocates, which is the plan's capacity in pages. */
  readonly totalPages: number;
  /** The number of bytes the plan makes addressable. */
  readonly capacity: number;
  /** The base of each function's scratch, in the order they are numbered. */
  readonly scratchBases: readonly number[];
  /** The scratch size of each function, as measured. */
  readonly scratchSizes: readonly number[];
  readonly alignment: number;
  readonly wide: WasmRegion;
  readonly reserved: WasmRegion;
  readonly static: WasmRegion;
  readonly runtime: WasmRegion;
  /** The first address the host may hand out, which is `runtime.offset`. */
  readonly dataBase: number;
}

function violation(message: string, detail: string): never {
  throw new Error(`${message}: ${detail}`);
}

/** Rounds a value up to a multiple of an alignment. */
export function wasmAlignUp(value: number, alignment: number): number {
  if (!Number.isSafeInteger(value) || value < 0) violation("invalid WebAssembly memory size", `${value} is not a non-negative integer`);
  const rest = value % alignment;
  return rest === 0 ? value : value + (alignment - rest);
}

function checkedSize(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) violation("invalid WebAssembly memory requirement", `${what} is ${value}, not a non-negative integer`);
  return value;
}

function region(name: WasmRegionName, offset: number, size: number, alignment: number): WasmRegion {
  return { name, offset, size, alignment };
}

/**
 * Lays out the module's memory from measured requirements.
 *
 * The regions are, in order: the wide-word scratch the functions share, the
 * padding that aligns the constants, the statically initialised constants, and
 * the runtime's allocation space. The module declares only the pages its own
 * regions need; the host adds its working pages when it creates the memory.
 */
export function planWasmMemory(requirements: WasmMemoryRequirements): WasmMemoryPlan {
  const alignment = requirements.alignment ?? WASM_REGION_ALIGNMENT;
  if (!Number.isSafeInteger(alignment) || alignment <= 0 || (alignment & (alignment - 1)) !== 0) {
    violation("invalid WebAssembly memory alignment", `${alignment} is not a positive power of two`);
  }

  const scratchSizes = requirements.scratchSizes.map((size) => checkedSize(size, "a function's scratch size"));
  const scratchBases: number[] = [];
  let wideSize = 0;
  for (const size of scratchSizes) {
    scratchBases.push(wideSize);
    wideSize += size;
    if (!Number.isSafeInteger(wideSize)) violation("WebAssembly scratch overflows", "the sum of the functions' scratch is not an integer");
  }
  // A pointer of zero is the host's null, so the module's regions begin above
  // a reserved guard. The guard's size is already an alignment unit, which
  // leaves the wide region on a boundary.
  const guardBytes = wasmAlignUp(requirements.guardBytes ?? WASM_NULL_GUARD, alignment);
  if (guardBytes === 0) violation("invalid WebAssembly memory plan", "the null guard must not be empty");
  const reserved = region("reserved", 0, guardBytes, alignment);
  const wideAligned = wasmAlignUp(wideSize, alignment);
  const wide = region("wide", guardBytes, wideAligned, alignment);
  const staticBase = guardBytes + wideAligned;

  // Static data is rounded up so the runtime's region starts on an alignment
  // boundary, and the segment the host writes carries exactly that many bytes.
  const staticSize = wasmAlignUp(checkedSize(requirements.staticSize, "the static data size"), alignment);
  const statics = region("static", staticBase, staticSize, alignment);
  const staticEnd = staticBase + staticSize;
  if (!Number.isSafeInteger(staticEnd)) violation("WebAssembly static data overflows", "the static data does not fit in an integer address");

  const rawPages = Math.ceil(staticEnd / WASM_PAGE_SIZE);
  const pages = Math.max(1, rawPages);
  const runtimePages = checkedSize(requirements.runtimePages ?? WASM_RUNTIME_PAGES, "the host's runtime pages");
  if (!Number.isSafeInteger(pages + runtimePages)) violation("WebAssembly page count overflows", "the page count is not an integer");
  const totalPages = pages + runtimePages;
  if (totalPages < 1) violation("invalid WebAssembly page count", `the plan reserves ${totalPages} pages`);
  const capacity = totalPages * WASM_PAGE_SIZE;
  if (!Number.isSafeInteger(capacity)) violation("WebAssembly memory overflows", `${totalPages} pages do not fit in an integer address`);

  const runtime = region("runtime", staticEnd, capacity - staticEnd, alignment);
  const regions: WasmRegion[] = [reserved, wide, statics, runtime];
  const plan: WasmMemoryPlan = {
    regions,
    pages,
    runtimePages,
    totalPages,
    capacity,
    scratchBases,
    scratchSizes,
    alignment,
    wide,
    reserved,
    static: statics,
    runtime,
    dataBase: runtime.offset,
  };
  validateWasmMemoryPlan(plan);
  return plan;
}

/** Rejects a plan whose regions overlap, escape memory, or break alignment. */
export function validateWasmMemoryPlan(plan: WasmMemoryPlan): void {
  if (!Number.isSafeInteger(plan.pages) || plan.pages < 1) violation("invalid WebAssembly memory plan", `the module imports ${plan.pages} pages`);
  if (!Number.isSafeInteger(plan.totalPages) || plan.totalPages < plan.pages) violation("invalid WebAssembly memory plan", "the host has no room past the module");
  const capacity = plan.totalPages * WASM_PAGE_SIZE;
  if (!Number.isSafeInteger(capacity) || capacity !== plan.capacity) violation("invalid WebAssembly memory plan", "the capacity is not the page count times the page size");
  if (plan.regions.length === 0) violation("invalid WebAssembly memory plan", "the plan has no regions");

  let previous: WasmRegion | null = null;
  for (const current of plan.regions) {
    if (!Number.isSafeInteger(current.offset) || current.offset < 0) violation("invalid WebAssembly memory region", `${current.name} has offset ${current.offset}`);
    if (!Number.isSafeInteger(current.size) || current.size < 0) violation("invalid WebAssembly memory region", `${current.name} has size ${current.size}`);
    if (current.size > plan.capacity - current.offset) violation("WebAssembly memory region out of bounds", `${current.name} reaches past the plan's capacity`);
    if (current.alignment > 1 && current.offset % current.alignment !== 0) {
      violation("unaligned WebAssembly memory region", `${current.name} starts at ${current.offset}, not a multiple of ${current.alignment}`);
    }
    if (previous !== null && previous.offset + previous.size > current.offset) {
      violation("overlapping WebAssembly memory regions", `${previous.name} ends at ${previous.offset + previous.size} but ${current.name} starts at ${current.offset}`);
    }
    previous = current;
  }
  if (plan.dataBase !== plan.runtime.offset) violation("invalid WebAssembly memory plan", "the data base is not the runtime region's start");
}

/** The number of pages a region of so many bytes needs. */
export function wasmPagesFor(bytes: number): number {
  return Math.max(1, Math.ceil(checkedSize(bytes, "a byte count") / WASM_PAGE_SIZE));
}

/**
 * Resolves a symbolic address against a plan, refusing one that leaves the
 * region it claims. A region boundary is a hard limit: the module never reads
 * a constant out of the scratch and the host never allocates over either.
 */
export function wasmAddressOf(plan: WasmMemoryPlan, ref: WasmAddressRef): number {
  if (ref.kind === "static") {
    const region = plan.static;
    if (!Number.isSafeInteger(ref.offset) || ref.offset < 0 || ref.offset >= region.size) {
      violation("static WebAssembly address out of bounds", `${ref.offset} is outside the static region of ${region.size} bytes`);
    }
    const address = region.offset + ref.offset;
    if (address >= region.offset + region.size) violation("static WebAssembly address out of bounds", `${address} is past the static region`);
    return address;
  }
  if (!Number.isSafeInteger(ref.fn) || ref.fn < 0 || ref.fn >= plan.scratchSizes.length) {
    violation("WebAssembly scratch address out of bounds", `no function ${ref.fn} has scratch in this plan`);
  }
  const size = plan.scratchSizes[ref.fn] as number;
  if (!Number.isSafeInteger(ref.offset) || ref.offset < 0 || ref.offset >= size) {
    violation("WebAssembly scratch address out of bounds", `${ref.offset} is outside function ${ref.fn}'s ${size} bytes of scratch`);
  }
  const address = plan.wide.offset + (plan.scratchBases[ref.fn] as number) + ref.offset;
  if (address < plan.wide.offset || address >= plan.wide.offset + plan.wide.size) {
    violation("WebAssembly scratch address out of bounds", `${address} is outside the wide region`);
  }
  return address;
}

/** Adds a constant displacement to an address reference. */
export function wasmAddressPlus(ref: WasmAddressRef, bytes: number): WasmAddressRef {
  return { kind: ref.kind, fn: ref.fn, offset: ref.offset + bytes };
}

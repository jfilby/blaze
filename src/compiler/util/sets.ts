/**
 * Efficient set representations for the compiler.
 *
 * Three representations are provided, and a factory picks the cheapest one
 * that fits a given collection of values:
 *
 *   - BitSet: a bit vector over a small, bounded, non-negative integer
 *     domain. Union, intersection and difference are word (BigInt) operations.
 *   - SparseSet: the classic dense/sparse array pair for compiler-internal
 *     integer ids. Constant-time membership, insertion and removal.
 *   - HashSet: a hash table for arbitrary values.
 *
 * Selection is by value domain and density, not by guess: measure first.
 */

/** A bitset over non-negative integers up to `universe - 1`. */
export class BitSet {
  private bits: bigint;
  readonly universe: number;

  constructor(universe: number) {
    this.universe = universe;
    this.bits = 0n;
  }

  static fromValues(values: readonly number[], universe: number): BitSet {
    const set = new BitSet(universe);
    for (const v of values) set.add(v);
    return set;
  }

  add(value: number): void {
    if (value < 0 || value >= this.universe) throw new RangeError(`value ${value} outside universe ${this.universe}`);
    this.bits |= 1n << BigInt(value);
  }

  has(value: number): boolean {
    if (value < 0 || value >= this.universe) return false;
    return (this.bits & (1n << BigInt(value))) !== 0n;
  }

  delete(value: number): void {
    if (value < 0 || value >= this.universe) return;
    this.bits &= ~(1n << BigInt(value));
  }

  union(other: BitSet): BitSet {
    const result = new BitSet(Math.max(this.universe, other.universe));
    result.bits = this.bits | other.bits;
    return result;
  }

  intersect(other: BitSet): BitSet {
    const result = new BitSet(Math.min(this.universe, other.universe));
    result.bits = this.bits & other.bits;
    return result;
  }

  difference(other: BitSet): BitSet {
    const result = new BitSet(this.universe);
    result.bits = this.bits & ~other.bits;
    return result;
  }

  symmetricDifference(other: BitSet): BitSet {
    const result = new BitSet(Math.max(this.universe, other.universe));
    result.bits = this.bits ^ other.bits;
    return result;
  }

  isSubsetOf(other: BitSet): boolean {
    return (this.bits & ~other.bits) === 0n;
  }

  get size(): number {
    let n = 0;
    let b = this.bits;
    while (b !== 0n) {
      n += Number(b & 1n);
      b >>= 1n;
    }
    return n;
  }

  values(): number[] {
    const out: number[] = [];
    let b = this.bits;
    let i = 0;
    // Iterate set bits only, skipping runs of zeros.
    while (b !== 0n) {
      if (b & 1n) out.push(i);
      b >>= 1n;
      i++;
    }
    return out;
  }

  equals(other: BitSet): boolean {
    return this.universe === other.universe && this.bits === other.bits;
  }
}

/** A sparse set over integer ids (the classic dense/sparse array pair). */
export class SparseSet {
  private dense: number[] = [];
  private sparse: number[] = [];
  private readonly universe: number;

  constructor(universe: number) {
    this.universe = universe;
    this.sparse = new Array(universe).fill(-1);
  }

  static fromValues(values: readonly number[], universe: number): SparseSet {
    const set = new SparseSet(universe);
    for (const v of values) set.add(v);
    return set;
  }

  add(value: number): boolean {
    if (value < 0 || value >= this.universe) return false;
    if (this.sparse[value] !== -1 && this.sparse[value] < this.dense.length && this.dense[this.sparse[value]] === value) return false;
    this.sparse[value] = this.dense.length;
    this.dense.push(value);
    return true;
  }

  has(value: number): boolean {
    if (value < 0 || value >= this.universe) return false;
    const index = this.sparse[value];
    return index !== -1 && index < this.dense.length && this.dense[index] === value;
  }

  delete(value: number): boolean {
    if (!this.has(value)) return false;
    const index = this.sparse[value];
    const last = this.dense[this.dense.length - 1];
    this.dense[index] = last;
    this.sparse[last] = index;
    this.dense.pop();
    this.sparse[value] = -1;
    return true;
  }

  get size(): number {
    return this.dense.length;
  }

  values(): number[] {
    return [...this.dense];
  }

  clear(): void {
    for (const v of this.dense) this.sparse[v] = -1;
    this.dense = [];
  }
}

/** A hash set for arbitrary values, keyed by a canonical string. */
export class HashSet<T> {
  private map: Map<string, T> = new Map();
  private keyFn: (v: T) => string;

  constructor(keyFn: (v: T) => string = (v) => String(v)) {
    this.keyFn = keyFn;
  }

  add(value: T): boolean {
    const key = this.keyFn(value);
    if (this.map.has(key)) return false;
    this.map.set(key, value);
    return true;
  }

  has(value: T): boolean {
    return this.map.has(this.keyFn(value));
  }

  delete(value: T): boolean {
    return this.map.delete(this.keyFn(value));
  }

  get size(): number {
    return this.map.size;
  }

  values(): T[] {
    return [...this.map.values()];
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Pick the cheapest representation for a collection of non-negative integers.
 *
 *   - BitSet when the domain is small and bounded (max <= 1024).
 *   - SparseSet when the domain is moderate (max <= 1_000_000).
 *   - HashSet otherwise.
 */
export function classifyIntegerSet(values: readonly number[]): "bitset" | "sparse" | "hash" {
  if (values.length === 0) return "sparse";
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (min < 0) return "hash";
  // Benchmarks (bench/sets.bench.ts) show SparseSet is faster than BitSet in
  // this runtime for the sizes and densities measured, so prefer it for all
  // bounded integer domains. BitSet remains available for callers that want
  // word-level operations on very small, dense domains.
  if (max <= 1_000_000) return "sparse";
  return "hash";
}

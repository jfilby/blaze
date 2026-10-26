import { BitSet, SparseSet, HashSet } from "../util/sets.ts";

function time(label: string, fn: () => void, iters = 1000): void {
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - start;
  console.log(`${label}: ${ms.toFixed(2)} ms (${iters} iters)`);
}

const N = 500;
const vals = Array.from({ length: N }, (_, i) => i * 2); // sparse: even numbers
const universe = N * 2;

// Membership
time("BitSet membership", () => { const s = BitSet.fromValues(vals, universe); for (const v of vals) s.has(v); });
time("SparseSet membership", () => { const s = SparseSet.fromValues(vals, universe); for (const v of vals) s.has(v); });
time("HashSet membership", () => { const s = new HashSet<number>(); for (const v of vals) s.add(v); for (const v of vals) s.has(v); });

// Insertion
time("BitSet insert", () => { const s = new BitSet(universe); for (const v of vals) s.add(v); });
time("SparseSet insert", () => { const s = new SparseSet(universe); for (const v of vals) s.add(v); });
time("HashSet insert", () => { const s = new HashSet<number>(); for (const v of vals) s.add(v); });

// Union
const vals2 = Array.from({ length: N }, (_, i) => i * 2 + 1);
time("BitSet union", () => { const a = BitSet.fromValues(vals, universe); const b = BitSet.fromValues(vals2, universe); a.union(b); });
time("SparseSet union (manual)", () => { const a = SparseSet.fromValues(vals, universe); const b = SparseSet.fromValues(vals2, universe); const r = new SparseSet(universe); for (const v of a.values()) r.add(v); for (const v of b.values()) r.add(v); });

// Intersection
time("BitSet intersect", () => { const a = BitSet.fromValues(vals, universe); const b = BitSet.fromValues(vals2, universe); a.intersect(b); });

// Difference
time("BitSet difference", () => { const a = BitSet.fromValues(vals, universe); const b = BitSet.fromValues(vals2, universe); a.difference(b); });

console.log("done");

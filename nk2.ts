export function demo(): string {
  const sets = new Map<string, Set<number>>();
  const first = new Set<number>();
  first.add(10);
  sets.set(`a`, first);
  const held = sets.get(`a`);
  const land = new Set<boolean>();
  land.add(true);
  land.add(false);
  return `${held?.has(10)} ${land.size}`;
}
console.log(demo());

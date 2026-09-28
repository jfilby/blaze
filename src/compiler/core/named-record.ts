/**
 * Records keyed by a name the source chose.
 *
 * A function, a parameter and a field are named by whatever the program calls
 * them, and `__proto__` is a legal identifier: the compiler only requires a
 * name to look like one. Building such a record by assignment is not building
 * it. `__proto__` is an inherited accessor, so `record[name] = value` replaces
 * the prototype instead of adding an entry, and every read afterwards answers
 * from `Object.prototype`: a duplicate check fires on a program that declares
 * a name once, and a record the build writes out is missing the entry it was
 * going to keep.
 *
 * `Object.fromEntries` defines the key as an ordinary own property, so the
 * result is a normal object that any legal name is a key of.
 */
export function byName<V>(entries: Iterable<readonly [string, V]>): Record<string, V> {
  return Object.fromEntries(entries);
}

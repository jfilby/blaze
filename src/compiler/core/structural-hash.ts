/**
 * Hashing a value by its structure rather than by a serialisation of it.
 *
 * A build used to hash a value by stringifying it. That materialised a string
 * as large as the value — the whole contract, or the ABIs of every other
 * function for every compilation unit — only to feed it to sha256 and throw it
 * away. The two callers that matter hash frozen contracts and freshly built
 * records, and neither needs the text: it needs a stable answer about what the
 * value holds.
 *
 * The walk here feeds tagged, length-delimited pieces of the structure into one
 * sha256 per object instead. Object keys are sorted, so two values written in a
 * different order are the same value; each type has its own tag, so a text
 * `"1"` is not a number `1` and a map is not the empty object it stringifies
 * to. Maps and sets are walked by their entries rather than dropped. The answer
 * is independent of how a value was formatted and sensitive to what it says.
 *
 * The digest of an object is cached by its identity, so a subtree shared by
 * unchanged values — the frozen contract every compilation unit of a build
 * hashes — is walked once. The values a build hashes are frozen or treated as
 * immutable; a value changed in place must be given a fresh object to be
 * hashed afresh, which is the contract callers already follow.
 */

import { createHash } from "./platform.ts";

/** The digest of each object already walked, so an unchanged subtree is reused. */
const hashed = new WeakMap<object, string>();

/** The objects on the path of the current walk, which a cycle may not revisit. */
type Active = Set<object>;

/**
 * A scalar's tagged, length-delimited encoding, written straight into its
 * parent's hash. A tag keeps values that a serialisation would confuse apart.
 */
function scalarPiece(value: unknown): string {
  if (value === null) return "null:";
  if (value === undefined) return "undefined:";
  switch (typeof value) {
    case "string":
      // The length prefix keeps a text containing separators unambiguous.
      return `text:${value.length}:${value}`;
    case "number":
      // Signed zero and the non-finite numbers are distinct values.
      return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
    case "boolean":
      return `boolean:${value ? "1" : "0"}`;
    case "bigint":
      return `bigint:${String(value)}`;
    case "symbol":
      return `symbol:${String(value.description ?? "")}`;
    case "function":
      return "function:";
    default:
      return "unknown:";
  }
}

/** One object's digest, from the pieces of the parts it holds. */
function hashObject(object: object, active: Active): string {
  const isArray = Array.isArray(object);
  const tag = isArray
    ? "array"
    : object instanceof Map
      ? "map"
      : object instanceof Set
        ? "set"
        : object instanceof Date
          ? "date"
          : "object";
  const hash = createHash("sha256").update(tag, "utf8");

  if (isArray) {
    const array = object as readonly unknown[];
    hash.update(`[${array.length}:`);
    for (let index = 0; index < array.length; index += 1) {
      hash.update(`${index}=`);
      hash.update(index in array ? pieceOf(array[index], active) : scalarPiece(undefined));
      hash.update(";");
    }
  } else if (object instanceof Map) {
    const entries = [...object.entries()].map(([key, value]) => [pieceOf(key, active), pieceOf(value, active)] as const);
    entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    hash.update("{");
    for (const [key, value] of entries) hash.update(`${key}:${value};`);
  } else if (object instanceof Set) {
    const members = [...object].map((value) => pieceOf(value, active));
    members.sort();
    hash.update("[");
    for (const member of members) hash.update(`${member};`);
  } else if (object instanceof Date) {
    hash.update(object.toISOString(), "utf8");
  } else {
    // Object.keys gives own enumerable keys in the order a value was written;
    // sorting them is what makes two equivalent representations agree.
    const keys = Object.keys(object).sort();
    hash.update("{");
    for (const key of keys) {
      hash.update(`${key.length}:${key}=`);
      hash.update(pieceOf((object as Record<string, unknown>)[key], active));
      hash.update(";");
    }
  }
  hash.update("}", "utf8");
  return hash.digest("hex");
}

/** The piece one value contributes to a parent: a digest, or a scalar encoding. */
function pieceOf(value: unknown, active: Active): string {
  if (value === null || typeof value !== "object") return scalarPiece(value);
  const object = value as object;
  const cached = hashed.get(object);
  if (cached !== undefined) return cached;
  if (active.has(object)) throw new TypeError("Converting circular structure to a hash");
  active.add(object);
  let answer: string;
  try {
    answer = hashObject(object, active);
  } finally {
    active.delete(object);
  }
  hashed.set(object, answer);
  return answer;
}

/** The structural hash of a value, as a 64-character hex digest. */
export function hashValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return createHash("sha256").update(scalarPiece(value), "utf8").digest("hex");
  }
  return pieceOf(value, new Set<object>());
}

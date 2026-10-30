# Maps and sets

## What it is

`Map<string, V>` and `Set<string>` are one handle on the runtime's dictionary —
`blaze_rt_dict_*`, which is a small open-addressed table of text keys and
`double` values. A set is a map whose value is the number one, so the two are one
value with two sets of names.

```ts
const counts = new Map<string, number>();
counts.set(`a`, 1);
const seen = new Set<string>();
seen.add(`a`);
```

A map is a handle, which is not a type the contract can spell, so the frontend
keeps what a name holds beside the name: `m.get(k)` answers the value type the
source declared. That is the same shape `valueArrows` and `valueFunctions` have —
the value is opaque and the frontend knows what it is.

## What a body can do

| written | lowered to |
|---|---|
| `new Map<K, V>()`, `new Set<V>()` | `blaze_rt_dict_new()` |
| `m.set(k, v)` | `blaze_rt_dict_set(m, k, v)` |
| `m.get(k)` | `has(m, k) ? get(m, k) : 0` |
| `m.has(k)` | `blaze_rt_dict_has(m, k) === 1` |
| `m.delete(k)` | `blaze_rt_dict_delete(m, k)` |
| `m.size` | `blaze_rt_dict_len(m)` |
| `s.add(v)`, `s.has(v)`, `s.delete(v)`, `s.size` | the same, with the value `1` |

The `has` comparison is `=== 1` because the runtime answers a truth with a
number, and a body that writes `!s.has(k)` is asking a question about a truth.

`get` is guarded rather than a bare read because **a value here has no
`undefined`**: an absent key answers the zero of the value type, which is the
same zero an element read outside a buffer answers. The consequence is worth
stating: `m.set(k, m.get(k) + 1)` counts from zero where JavaScript counts from
`NaN` — the source idiom there is `(m.get(k) ?? 0) + 1`, and both forms give the
same answer here.

`delete` was added to the runtime for this slice: the entry is removed and the
last entry takes its place, so the table stays whole.

## What is not carried

- **A key that is not text.** The dictionary is keyed by a string, so
  `Map<number, …>`, `Set<number>` and a map keyed by a reference are refused at
  the annotation: *a Set here is keyed by text, not by f64*.
- **A value that is not a number.** `Map<string, string>` and
  `Map<string, Node>` are refused at `get` and `set`: the dictionary holds
  doubles and the two conversions this backend has between a handle and a text or
  a reference are not written yet.
- **Iterating.** `for (const [k, v] of m)` needs destructuring in a `for..of` and
  a loop over a dictionary; `m.keys()` has no value to hand over. Neither is
  carried, so a map is read by key.
- **`Map` and `Set` inside a class field.** A field is one word and the layout
  says a type per field; see `typescript-arrays.md` for the same limit.

## What is next

- A text or a reference as the value of a map: the runtime already stores a
  pointer as a double, so what is missing is the two conversions, and the
  unboxing a text needs on the way out.
- Iterating a map, which is destructuring in a `for..of` and a loop over the
  dictionary's entries.
- `Map<K, V>` over a key that is not text, which is a hash of the key rather than
  the key itself.

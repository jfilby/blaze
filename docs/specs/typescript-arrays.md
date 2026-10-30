# Arrays of text and references

## What it is

An array of a type the frontend can name is a slice of that type, which is what
a typed array already was:

```ts
const names: string[] = [`ab`, `cde`];   // slice<text>
const nodes: Node[] = [first, second];   // slice<ref<Node>>
const grid: number[][] = [[1], [2]];     // slice<slice<f64>>
```

`T[]`, `Array<T>` and `ReadonlyArray<T>` are the same annotation, and a nested
`T[][]` is a slice of slices. A type the frontend cannot name — a function type,
an unknown — is the opaque reference, as everywhere else.

In the C backend a slice of text is a `const char**` and a slice of references is
a `struct Node**`: one word per element, the length beside it, which is the shape
a `Float64Array` already had. Nothing about the representation is new.

## What a body can do with one

| written | lowered to |
|---|---|
| `[a, b, ...c]` | a block written out, or `a + b + c` where a value is spread |
| `a[i]`, `a.length` | the element and the length, at the element type |
| `for (const x of a)` | a counted loop with `x` bound to the element |
| `a.join(sep)` | a function of the file that builds the text |
| `a.includes(x)`, `a.indexOf(x)` | a walk comparing each element |
| `a.map(f)`, `a.filter(f)`, `a.find(f)`, `a.findIndex(f)`, `a.some(f)`, `a.every(f)`, `a.forEach(f)`, `a.reduce(f[, init])`, `a.sort(f)` | the same walks the numeric arrays already had |
| `a.push(x)`, `a.pop()` | an assignment to the array the name holds |

The walking methods are the ones described in `typescript-arrows.md`: each is a
function of the file the frontend writes, cached per shape, that walks the array
and calls the closure. `map` now answers an array of whatever its callback
answers, so `a.map((s: string) => s + "!")` is an array of text; a callback that
answers a list is refused, because a value here is one array and not an array of
arrays.

`join` writes each element as the text it is: a text element is the string the
runtime holds, and a number is written by the same interpolation every other
text is written with.

## `push` and `pop` change the name, not the block

An array here is a block *and* a length, and the length travels beside the name
rather than inside the block. Growing one therefore cannot write into the block
the name already holds:

```ts
const out: string[] = [];
for (...) out.push(name);
```

is

```ts
out = __collect_main_0(out, name);
```

where the helper writes a block of one more element. That is a copy of the
elements on every push, and a program that builds a large array one element at a
time is quadratic in it. A representation that carried the length inside the
block would grow in place; that is a later slice, and it changes what a slice
parameter is passed as, so it is not a detail of this one.

Two consequences, both stated rather than papered over:

- **`push` and `pop` are statements.** They answer the array the name has
  afterwards, so `const n = a.push(x)` is refused at the lowering: nothing here
  is that number.
- **A name copied before a push keeps the array it had.** `const b = a; a.push(x)`
  leaves `b` holding the block `a` held, with the length it had. Nothing dangles;
  the two names are two arrays from that point on.

## What was fixed on the way

- **A text a turn builds is a block the turn owns.** The loop-region pass read
  only reference kinds and array types, so a loop whose turn built a string and
  stored it somewhere that outlives the turn was marked for reuse, and the string
  the next turn built was written over it. `map` over text is what found it.
- **A call this build cannot name may build.** `calleeBuilds` answered "no" for
  a name it did not hold, which is a call through a closure. It now answers "may
  build" for a body nobody has read, and "no" only for a builtin.
- **A nested text value took the declarations of the one around it.** The text
  builder took every pending declaration rather than the ones it wrote, so
  `a + b` where `b` was itself built referred to a name whose declaration had
  gone into an expression it was not part of.
- **A length that travels beside a name travels with it.** Assigning an array to
  a name updated the name and not the length, so a second push read the array as
  the length it had before the first.
- **A type name is not an identifier.** Temporaries were named after the element
  type, so a block of text was `const char*_block_1`.

## What is not carried

- **An array in a field of a class.** A layout gives a field a type and no
  length, and an array here is a block *and* a length: `items: string[] = []` as
  a field has nowhere to keep the count a `push` would change. A local, a
  parameter and a return are all carried; a field is not.
- **A length inside the block.** See above: `push` copies.
- **An array of arrays built by a callback.** `flatMap` answers one.

## What is next

- `splice`, `shift`, `unshift`, `concat` as a method, and `slice` on an array.
- A length inside the block, so `push` grows in place and the cost of building an
  array one element at a time is linear.
- `flatMap`, which is an array of arrays.

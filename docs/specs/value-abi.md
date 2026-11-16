# The Blaze value ABI

This is the authoritative definition of a dynamic value crossing between
compiled code and a runtime. It replaces the earlier convention in which every
value was a `double`, a large `double` was assumed to be a pointer, and an
object's kind was discovered by reading a magic word before that pointer.

The rules here apply to every backend — C, Nim and WebAssembly. One copy of the
tag numbers, handle layout and ownership rules lives in
`src/compiler/runtime/value-abi.ts`; the C header, the Nim adapter and the wasm
host declarations are generated from it. No backend may hard-code a tag or a
handle encoding of its own.

## 1. The value

A `BlazeValue` is a 16-byte record with an out-of-band tag. The tag is separate
from the payload so the payload can hold every bit of an IEEE-754 double,
including NaN and both infinities.

```
offset  size  field
     0     8  payload   the value's bits, interpreted according to tag
     8     4  tag       one of BLAZE_VALUE_*
    12     4  kind      handle subtype, or 0 for a non-handle
```

```c
typedef enum {
  BLAZE_VALUE_NUMBER  = 0,  /* payload: the IEEE-754 bits of a double */
  BLAZE_VALUE_BOOLEAN = 1,  /* payload: 0 or 1 */
  BLAZE_VALUE_NULL    = 2,  /* payload: 0 */
  BLAZE_VALUE_HANDLE  = 3,  /* payload: a managed handle; kind: its subtype */
  BLAZE_VALUE_EXTERNAL = 4, /* payload: a typed external handle; kind: resource */
} BlazeValueTag;
```

A `double` is converted to and from a value by moving its bits, never by
comparing it with a range. `blaze_value_number(x)` stores `memcpy` of `x`;
`blaze_value_number_of(v)` requires `v.tag == BLAZE_VALUE_NUMBER` and moves the
bits back. No other tag is ever interpreted as a number.

A boolean is a value of its own. It is not a number that happens to be zero or
one, and a false is not the null value.

## 2. Handles

A handle is a pair of 32-bit halves packed into the payload:

```
bits 0..31   index into the runtime registry
bits 32..63  generation of the slot
```

Index zero is never a handle; it is the invalid handle. The registry is a
dynamically grown array of entries. When an entry is released its generation is
incremented and the slot joins a free list. A handle presented after its entry
was reused carries the old generation and is rejected, so a released handle
cannot become a valid reference to a later allocation.

```
typedef enum {
  BLAZE_HANDLE_STRING  = 1,
  BLAZE_HANDLE_RECORD  = 2,
  BLAZE_HANDLE_ARRAY   = 3,
  BLAZE_HANDLE_OBJECT  = 4,  /* a parsed document or dictionary */
  BLAZE_HANDLE_CLOSURE = 5,
  BLAZE_HANDLE_BUFFER  = 6,
} BlazeHandleKind;
```

Every registry entry carries:

```
kind          the subtype above
generation    incremented on release
state         live or released
ownership     owned by the runtime, or an external buffer the runtime borrows
pointer       the object's storage, internal to the runtime
length        bytes or elements, according to kind
capacity      storage the entry may use without reallocating
references    live references held by the registry and by the program
```

Access to a handle validates, in order: that the value's tag is `HANDLE`; that
the subtype matches the operation; that the index is within the registry; that
the slot is live; and that its generation equals the handle's. Any failure
raises a deterministic runtime error naming the operation and the reason. No
access dereferences `pointer` before those checks pass.

## 3. Objects, strings and external memory

A string, a record and an array are registry entries, not a pointer with data
before it. Their length is in the entry. There is no magic word, no header
probe, and no guard bytes reserved so a probe can read mapped memory.

A C string literal or a buffer owned by a host is registered with an explicit
external-buffer entry: it records the pointer, the known length and the fact
that the runtime borrows rather than owns it. A literal is immutable; a write
through a handle to it is a runtime error. A managed string is allocated with
its length in its registry entry, and a read of its length never examines the
bytes before an arbitrary address.

A record keeps its layout descriptor in its registry entry. Reading the keys of
a value that cannot be named is a walk of that descriptor, not a guess based on
the numeric size of a handle.

## 4. External resources

SQLite connections and statements, files, and FFI resources use
`BLAZE_VALUE_EXTERNAL` values. `kind` names the resource type and the payload
is a typed handle into a resource table of the same shape as the object
registry. A resource handle validates its type and generation exactly as an
object handle does. A resource is never passed as a string, a number or a raw
pointer, and a runtime service never has to infer which it was given.

## 5. Globals

Module-level values live in a dynamically sized table of `BlazeValue`s, not a
fixed `blaze_rt_globals[4096]`. A slot outside the table raises a runtime error
naming the slot; it is never clamped to slot zero. The contract phase remains
responsible for assigning disjoint slot ranges to the modules of a program.

## 6. Bounds

An element access carries its length explicitly: an array handle carries the
length in its registry entry, a buffer carries the length the IR gives it, and
a string carries its byte length. Before every read or write the runtime
compares the index with that length and raises on an out-of-range index. There
is no reliance on overflow checks or on an allocation's capacity standing in
for its logical length.

## 7. Conformance

The migration is landed in C, Nim and the wasm host for every dynamic-value
service. The one exception is `blaze_rt_json_stringify`, which the machine
backend still calls through a scalar projection: its argument and answer are a
registry handle carried in a `double`, because that backend's foreign-call
convention has no 16-byte struct return. The tagged entry
`blaze_rt_json_stringify_value` is what C and Nim use, and the scalar entry is
implemented in terms of it. Removing the scalar projection requires adding a
struct-return path to the machine backend's `callSymbol`.

The C header declares `BlazeValue`, the tag and kind constants, and the
validating accessors. The Nim adapter declares an `object` with the same field
order and integer widths. The wasm host exposes the same layout in linear
memory at the shared base: an `i64` payload, an `i32` tag and an `i32` kind,
with the same numeric values for every constant. A conformance test compiles
small programs that move a NaN, an infinity, each handle kind, an external
string, an out-of-range global and an invalid handle across each boundary and
asserts the same answer from all three backends.

The acceptance criteria are:

- no dynamic value encodes a pointer in a `double`;
- no runtime operation identifies an object by numeric range or memory probe;
- full IEEE-754 numbers survive unchanged, including NaN and infinities;
- every object and resource access validates type and handle liveness;
- element accesses enforce explicit bounds;
- C, Nim and wasm implement the one ABI;
- an out-of-range global is an error, never slot zero;
- existing language semantics and tests remain intact.

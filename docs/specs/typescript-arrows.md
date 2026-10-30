# Arrow functions and closures in a TypeScript function body

## Lifting an arrow into a function

An arrow function written inside a function of a module is lifted into a
function of the same file. Its body becomes a `TypeScriptFunction` the module
declares — the same declaration a `function` statement makes — and the values
it captured become its leading parameters, in the order the body first reads
them.

```ts
export function add(x: number): number {
  const plus = (y: number): number => y + x;
  return plus(2);
}
```

becomes, as the two declarations the module holds (written here as the source
they correspond to, not as the IR):

```ts
function add(x: number): number {
  const plus = null;               // the name is not a slot the body reads
  return __closure_0(x, 2);
}
function __closure_0(x: number, y: number): number {
  return y + x;
}
```

Called by the name it is bound to, an arrow is that direct call: the call site
writes the captured values in front of its own arguments. An arrow written
where it is called, `((a: number) => a + x)(2)`, is the same rewrite.

Because the lifted function is an ordinary function of the module, nothing else
in the compiler changed to support it. It is contracted, validated, folded,
lowered and linked by the same passes as any other function, and both backends
lower it. The markers are `DeclaredFunction.internal`, which keeps it out of
the module's exports, and `TypeScriptFunction.closure`, which keeps it from
stating a postcondition or a buffer bound: nobody outside the declaration that
wrote the arrow calls it.

## A first-class function value: the closure

Read where a value is expected — passed to a call, returned, held at a function
type — an arrow is a **closure**. Two things are added to the compiler for it.

**The value.** `SemanticValue` gains

```ts
{ k: "closure"; type; code: string; signature: FunctionSignature; captures: SemanticValue[] }
{ k: "capture"; type; closure: SemanticValue; index: number }
```

A closure is one reference: the code that enters it, and the values it captured.
It is built where the arrow is written, so the captured values are read there
and travel with it. `capture` reads one of them back out, at the position and
type the arrow read it at. `signature` is what `code` is declared as, because a
value built in one file may be called in another.

**The call.** `SemanticCall` gains `through?: SemanticValue`. A call through a
closure names no callee; it names its signature from the arguments written at
the call site, because the value does not carry the types its parameters were
declared with. In the frontend IR the same call is `{ k: "invoke" }`, which the
parser writes when the callee is a name held at a function type.

The frontend writes an entry function beside each arrow that is used as a value:

```ts
function __closure_code_0(self: any, y: number): number {
  return __closure_0(self, y);      // `self` read for capture 0
}
```

It is written only when a value needs one, so an arrow that is only ever called
by its name costs nothing. It is a function of the file and is compiled, linked
and validated like any other.

### What the backends do

The C backend lays a closure out as one managed block:

```c
typedef struct { void* pointer; double number; } blaze_fn_capture_t;
typedef struct { void* code; blaze_fn_capture_t captured[1]; } blaze_fn_closure_t;
```

A capture travels as the address of it where it is a string, a buffer or a
reference, and as the number it is otherwise, so a capture that is not a whole
number arrives as it was written. A buffer's length travels in the `number`
beside its pointer. A call through a closure casts the code address to the
signature the call site states and hands the closure itself over first, so the
entry function can read what it captured.

The machine backend refuses a value that is two words. `machineError` is a
refusal, so a program that builds a closure is lowered whole by the C backend
and the build records `backendFallback`.

## What is refused, and why

- **An arrow that writes a name of the function around it.** A lifted arrow
  receives the captured value as a parameter, so a write would land in its own
  copy and the function it was written in would never see it. A write *through*
  a captured reference — `o.a = v`, `a[i] = v` — is still a capture and works:
  what the arrow holds is the object itself.
- **An arrow that calls the name it is bound to.** A call of the name passes the
  values the arrow captured, and the arrow cannot name them until the
  declaration it is bound to is complete. A function that recurses is declared
  with `function`.
- **A parameter with a default.** A default is a second entry point, which the
  module states as an overload; an arrow has no name to hang one on.

## Collection methods that take a callback

`map`, `filter`, `forEach`, `every`, `some`, `find`, `findIndex`, `reduce` and
`sort` are read on a typed array. None of them is a builtin: each is lowered to
**a function of the file that walks the array**, which is the loop the source
would have written.

```ts
const b = a.map((x: number): number => x * 2);
```

becomes a call of a function the frontend writes:

```ts
function __collect_0(items: Float64Array, fn: any): Float64Array {
  const out = new Float64Array(items.length);
  for (let i = 0; i < items.length; i++) out[i] = fn(items[i]);
  return out;
}
```

The helper is a declaration of the same module, so it is contracted, validated,
folded, lowered and linked like any other. Its parameters are the array and the
closure, and the closure is called through the value it holds — so a callback
may be an arrow written at the call, a name bound to one, or a parameter of
function type. A callback is handed the element and, where it declares them, the
index and the array; `thisArg` is not carried, because a closure has no `this`.

Two consequences of walking with a real loop:

- **`filter` calls its predicate once per element.** The elements it kept are
  written into a block as they are found, and the answer is a block of exactly
  the ones kept — a two-pass count-then-fill would call the predicate twice.
- **`sort` sorts where the array lies and answers a block of its own.** A call
  written for what it does still writes the array it was handed; what it answers
  is a block whose length travels with it.

A method call is read only where the receiver is a typed array, so a class that
declares `map` keeps it. The call is refused where the callback is not a
function this compiler can call, and where `map`'s callback answers something a
typed array does not hold.

### The length of what a call answers

An array that reaches a function is a pointer and a length passed beside it, and
a function that *answers* an array hands back only the pointer. What makes
`.length` of a collection call answer is the runtime's own header: a block the
runtime laid out records how many bytes it holds, so a block of elements holds
its count in those bytes. A name bound to a call therefore reads its length from
the block, and so does a `.length` written directly on the call.

That is why every helper answers a block of its own. A block the caller lent —
which is what `sort` would answer if it returned its parameter — has no header
the answer can trust, so the sorted answer is copied into one.

## Semantics of a capture

A captured value is read **where the arrow is written** and travels in the
closure from there. That is what makes an escaping closure answer: the value it
captured has already been copied into the block. It is not a reference to the
declaration, so a name that is written *after* the arrow is written is not seen
by the arrow. Writing a captured name is refused above; reading one after it
has been written is the one case where this differs from the source language,
and it is the same rule the program body's own closures follow.

## What is next

- `find` answers the zero of its element type where the callback accepts
  nothing, because a value here has no `undefined`. A source that reads the
  answer of a `find` must know the element it wants is there.
- `flatMap` is not carried: it answers an array of arrays, and a value here is
  one array of numbers.
- A receiver that is a field of an object is not read as an array: the layout
  pass does not say what an `any` field holds, so `this.items.map(f)` is not
  recognised. A local or a parameter is.
- A collection method is read in a function body. The statements a program runs
  at the top of its entry module hold numbers and strings, so a name bound to
  the array a method answers is not a value a program body carries.

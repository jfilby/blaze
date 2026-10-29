# Arrow functions in a TypeScript function body

## What is done

An arrow function written inside a function of a module is lifted into a
function of the same file. Its body becomes a `TypeScriptFunction` the module
declares — the same declaration a `function` statement makes — and the values
it captured become its leading parameters, in the order the body first reads
them. A call of the name the arrow is bound to is rewritten to a call of the
lifted function with those values written in front of the arguments the source
wrote.

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

An arrow written where it is called is the same rewrite:
`((a: number) => a + x)(2)` is `__closure_0(x, 2)`.

Because the lifted function is an ordinary function of the module, nothing past
the frontend changed. It is contracted, validated, folded, lowered and linked
by the same passes as any other function, and both backends lower it. The only
marker is `DeclaredFunction.internal`, which keeps it out of the module's
exports, and `TypeScriptFunction.closure`, which keeps it from stating a
postcondition or a buffer bound: nobody outside the declaration that wrote the
arrow calls it.

## What is refused, and why

Each of these is refused where it is written rather than lowered to something
that would silently answer a different value.

- **An arrow read as a value.** `h(g)` where `g` is bound to an arrow. A value
  of an arrow is a closure with an environment, which the IR does not carry.
- **An arrow that writes a name of the function around it.** A lifted arrow
  receives the captured value as a parameter, so a write would land in its own
  copy and the function it was written in would never see it. A write *through*
  a captured reference — `o.a = v`, `a[i] = v` — is still a capture and works:
  what the arrow holds is the object itself.
- **An arrow that calls the name it is bound to.** A call of the name passes
  the values the arrow captured, and the arrow cannot name them until the
  declaration it is bound to is complete. A function that recurses is declared
  with `function`.
- **A parameter with a default.** A default is a second entry point, which the
  module states as an overload; an arrow has no name to hang one on.

## What is next

The remaining gap is a first-class function value: an arrow handed to something
that calls it later. That is most of the arrows in this compiler's own sources
— `map`, `filter`, `forEach`, `every`, `some`, `find`, `reduce`, and the
higher-order helpers they are passed to — and it needs three things that do not
exist yet:

1. a value kind in `core/semantic-ir.ts` for a closure — a code symbol and the
   values it captured — and a call through one, which names the signature at the
   call site because the callee's type is not carried by the value;
2. a runtime representation: the C backend can hold a code pointer beside its
   captured values, and the machine backend needs a call through a register;
3. collection methods that take one, with the runtime calling it.

Until then, an arrow is a local function and nothing more, and the frontend says
so at the place the source escaped that.

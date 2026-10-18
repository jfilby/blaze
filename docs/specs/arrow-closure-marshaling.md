# Spec: Closure Marshaling for Arrow Callbacks

## Goal

Marshal captured variables from the enclosing scope into an arrow callback when
the runtime invokes it.

## To-dos

- Determine the set of captured names for each arrow (already computed by
  `readsAround` in `semantics/ir-resolve.ts`).
- Pass captures as extra parameters to the generated `__arrow_<line>` function.
- At the callback site, build a closure record holding the captured values.
- Generate a trampoline that unpacks the closure record and calls the arrow
  function with captures plus runtime arguments.
- Ensure mutable captures are written back or shared by reference.
- Add tests for arrows that read and mutate enclosing variables.

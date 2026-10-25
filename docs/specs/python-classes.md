# Python classes for Blaze

## Goal

Support a subset of Python's `class` sufficient for data-holding objects and
simple methods, lowered onto the existing object model (layouts, `fieldAssign`,
`memberAssign`).

## Stages

1. **Data-only records** (no methods): `class Point: x: int; y: int` lowers to a
   constructor function returning an object literal, reusing field assignment.
2. **Methods**: `def method(self, ...)`, dispatched as functions taking `self`
   as the first parameter (a reference to the layout).
3. **Construction**: `Point(1, 2)` and `Point(x=1, y=2)` call the constructor.
4. **Inheritance**: single inheritance and method resolution order.

## Type model

The frontend needs a way to name a layout in an annotation, because a method's
`self` and a function's object parameter must state which layout they hold.
The candidate is a `record[Name]` annotation mapped to the layout's reference
type, settled during the object pass.

## Status

Stage 1 not started. The parser currently refuses `class` by name with the
suggested object-literal form.

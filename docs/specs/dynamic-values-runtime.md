# Dynamic Values Runtime — Implementation Plan

## Representation decision

Dynamic values (`any`) are represented in C as `double` handles. A handle is
either:

- a tagged NaN-boxed pointer for heap-allocated dynamic values (strings,
  objects, arrays, hashers), or
- the raw double itself for numeric dynamic values.

This keeps `any` a single C type (`double`), so arithmetic, comparisons and
conditionals compile without special-casing, while heap values travel as handles
the runtime can unwrap.

Text values remain `char*` at the C boundary; a dynamic string is a handle whose
payload is a `char*`. The runtime exposes `blaze_rt_to_text(double)` to unwrap.

## Runtime ABI (already scaffolded)

- `blaze_rt_json_parse(double textHandle)` -> `double`
- `blaze_rt_json_stringify(double value)` -> `double`
- `blaze_rt_md5_create()` -> `double`
- `blaze_rt_md5_update(double hasher, const char* text)` -> `double`
- `blaze_rt_md5_digest(double hasher)` -> `double`
- `blaze_rt_file_read(const char* path, const char* mode)` -> `double`
- `blaze_rt_array_push(double array, double value)` -> `double`
- `blaze_rt_to_text(double value)` -> `const char*`

Each returns a managed handle (reference count 1) on success and calls
`blaze_rt_raise` on failure.

## Work items

1. **Heap value kinds.** Define a tagged struct in `runtime/abi.ts` source:
   `BLAZE_DYN` with a kind enum (number/string/object/array/hasher/null) and
   a union payload. Allocate via `blaze_rt_allocate`.

2. **Boxing helpers.** `blaze_rt_box_number(double)`, `blaze_rt_box_string(char*)`,
   `blaze_rt_box_null()`. Unboxing: `blaze_rt_as_number`, `blaze_rt_as_text`.

3. **JSON parse.** Recursive descent parser producing tagged values. Objects
   become arrays of key/value pairs (or a small hash map). Arrays become
   dynamic arrays. Strings/numbers/bools/null become boxed primitives.

4. **JSON stringify.** Recursive serializer over tagged values, producing a
   managed `char*`.

5. **MD5.** Implement RFC 1321 over a byte buffer; `create` allocates state,
   `update` appends (growing a buffer), `digest` finalizes and returns a hex
   string handle.

6. **File read.** `fopen`/`fread` into a managed buffer, return as string handle.

7. **Array push.** Dynamic array of `double` handles with geometric growth;
   return the (possibly reallocated) array handle.

8. **Codegen.** Update `toolchain/driver.ts` `builtin()` (already has cases) to
   pass handles. Update `toolchain/ir-c.ts` so that when an `any` value is used
   as a string (concat/interpolation), it calls `blaze_rt_to_text`. Update
   `toText` in the driver (already calls `blaze_rt_to_text`).

9. **Machine and WASM backends.** Add equivalent lowering for the dynamic
   builtins, or route them through the C runtime where the backend supports
   foreign calls.

10. **Tests.** Add frontend/resolver tests for dynamic values and an end-to-end
    `jsonserde` build+run test comparing against Node output.

## Ordering

Complete items 1-7 (runtime) before 8-9 (codegen), then 10. Each item should
land with its own tests to prevent regressions.

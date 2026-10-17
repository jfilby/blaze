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

1. **Heap value kinds.** Done in the standalone C runtime (`BLAZE_DYN` struct
   with kind enum and payload fields in `runtime/abi.ts`).

2. **Boxing helpers.** Done (`blaze_rt_box_number`, `blaze_rt_box_string`,
   `blaze_rt_box_null`, `blaze_rt_to_number`, `blaze_rt_to_text`).

3. **JSON parse.** Done in the standalone C runtime.

4. **JSON stringify.** Done in the standalone C runtime.

5. **MD5.** Done in the standalone C runtime.

6. **File read.** Done in the standalone C runtime.

7. **Array push.** Done in the standalone C runtime.

8. **Codegen (C).** Partial. `driver.ts` `builtin()` has cases and `ir-c.ts`
   boxes values and calls `blaze_rt_to_text` for `any`, but chained method calls,
   dynamic array literals and some conversions are not yet correct (see
   `jsonserde` IR).

9. **Machine and WASM backends.** Not started.

10. **Tests.** Not started. The Nim adapter also still returns stub values, so
    hosted builds are unsupported.

## Ordering

Complete items 1-7 (runtime) before 8-9 (codegen), then 10. Each item should
land with its own tests to prevent regressions.

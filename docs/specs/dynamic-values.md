# Dynamic Values in Blaze

## Goal

Allow Blaze programs to read, build, and pass values whose shape is not known
at compile time, so that programs such as `jsonserde` can be compiled.

## Motivation

The current compiler treats every value as having a static type from a small
set. Programs that consume JSON cannot be expressed in that model.

## Stages

1. Frontend and parsing. (done)
2. Type system: `any` as a first-class dynamic type. (done)
3. Resolver support for `any` arrays and boxing. (done)
4. Runtime representation and JSON/MD5 operations. (in progress)
5. Codegen lowering. (todo)
6. Tests and benchmarks. (todo)

## Done so far

- Frontend: `any`/`object`/`unknown` annotations map to `ref<any>`; method-style
  calls (`obj.method(...)`) and chained field reads are parsed.
- Type system: `ref<any>` (an unshaped reference) is treated as a universal
  dynamic type. Arrays, numbers, text and other references convert to it.
- Resolver: arrays may be passed where `any` is expected; dynamic values flow
  through binary/logical expressions and `console.log`; `process.argv` returns
  `any`.
- Builtins for `jsonserde` (`JSON.stringify`, `JSON.parse`,
  `crypto.createHash`, `fs.readFileSync`, `hasher.update`,
  `hasher.update.digest`, `array.push`) are declared with `any` signatures.
- IR validation accepts the resulting dynamic values.

## Remaining

- Runtime representation: implemented in the standalone C runtime for numbers,
  strings, arrays, objects and hashers. The Nim adapter still returns stub
  values, so hosted builds are not yet supported.
- Runtime operations: JSON parse/stringify, MD5 hashing, file read and array
  push are implemented in C.
- C codegen lowering: partially implemented. Boxing of values into `any`,
  dynamic array creation and `to_text` for `any` are handled, but chained method
  calls (e.g. `hasher.update(str).digest('hex')`), `any` array literals and
  numeric conversions in programs such as `jsonserde` are not yet lowered
  correctly.
- Machine and WASM backends: do not yet lower the dynamic builtins, and do not
  treat `ref<any>` as the double handle the runtime expects.
- Tests: no frontend/resolver or end-to-end tests for dynamic values exist yet;
  `jsonserde` does not yet build and run successfully.

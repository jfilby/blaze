# Spec: Deeper 256-Bit Signed/Wrapping Arithmetic for Blaze

## Problem
The new secp256k1 `1.ts` benchmark is written in native JavaScript `BigInt`
operations. Blaze currently lowers wide integer values as a four-limb `u256`.

This breaks secp256k1 in several ways:

1. `u256` is an unsigned 256-bit type, but secp field operations routinely
   produce negative intermediate values and require borrow wrapping.
2. Multiplication results are reduced before their modulus is known, unlike
   prime-field arithmetic over `P = 2^256 - 2^32 - 977`.
3. Modular inversion via extended Euclid relies on arbitrary quotients and signs.
4. Object-field layouts treat `x/y/z` as u256 in some places and i64 in others,
   creating inconsistent reference forms.

## Non-goal
The existing 24-bit limb approach remains the supported performance path for
generated machine code and should not be removed.

## Required compiler work

### 1. Signed 256-bit lane
Introduce a signed 256-bit type (`i256`) carrying magnitude and sign (or a
proper borrowed limb representation). Without this, negative values can never
be represented exactly enough for `mod`, `neg`, and inversion to be sound.

### 2. 512-bit multiplication and explicit reduction
`mod()` currently computes `result >= 0 ? result : b + result`, which is
incorrect for unsigned wrapping.  A correct path needs:
- wide 256x256 -> 512-bit product
- subsequent reduction modulo `P`
- no truncation before reduction.

### 3. Signed comparison semantics
Comparisons such as `<`, `<=`, `>`, `>=` must work over signed 256-bit lanes,
including zero signedness and -0 behavior retained from JavaScript.

### 4. Extended Euclidean support
`invert` needs signed high-width division and remainder.  Implement either:
- a true 256x256 -> quotient/remainder kernel, or
- a documented lower-level subroutine in the generated runtime.

### 5. Consistent field layouts
Jacobian and Affine coordinate fields must have a canonical 256-bit signed
type, rather than mixing `i64`/`u256` per expression shape, so any two
function paths returning the same coordinate layout resolve to one return type.

### 6. Ref-level typing
Methods operating on `any`-typed object parameters must retain either a layout
name or a monomorphic comparable type so `self.x`-style field reads are stable.

## Exit criterion
A clean `blaze build` of the current secp256k1 `1.ts` without modifying it,
followed by successful verification against the original Node output.

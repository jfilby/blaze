/**
 * hello_world: the smallest function that goes all the way through this
 * compiler.
 *
 * The TypeScript below is the input. The frontend turns it into a function
 * contract, the model writes an implementation, and the compiler assembles,
 * links, runs and verifies it against the contract. Nothing here is a mock:
 * `blaze build blaze.toml` compiles this file.
 */

export function dotProduct(a: Float64Array, b: Float64Array, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += a[i] * b[i];
  }
  return total;
}

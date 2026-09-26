/**
 * main: the plain Node side of the hello_world example.
 *
 * `hello_world.ts` is compiler input, not a program: the frontend accepts pure
 * functions only, so a `main` with calls and printing cannot live there. This
 * file is the executable side — it prints, calls `dotProduct` from the example
 * and prints the result:
 *
 *   node src/examples/hello_world/main.ts
 *
 * To run the compiled `dotProduct` instead, run `blaze build` in
 * `src/examples/hello_world` and start the delivered binary from a terminal:
 * it runs one built-in example vector, prints RESULT, and exits.
 */

import { dotProduct } from "./hello_world.ts";

const A = new Float64Array([1, 2, 3, 4]);
const B = new Float64Array([5, 6, 7, 8]);

console.log(`starting: dot product of ${A.length} elements`);

const total = dotProduct(A, B, A.length);

console.log(`done: dot product = ${total}`);

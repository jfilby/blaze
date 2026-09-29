/**
 * main: the program the compiler builds.
 *
 * A module of this compiler is either a library of pure functions or a
 * program. `hello_world.ts` is the library: the frontend turns it into a
 * function contract, the compiler resolves it into the semantic IR, and the
 * compiler assembles, links, runs and verifies what it lowered. This file is
 * the program: it declares the data, calls `dotProduct` and prints what came
 * back.
 *
 *   cd src/examples/hello_world
 *   blaze build
 *   .blaze/projects/hello_world/output/hello_world
 *
 * The build delivers a binary that prints exactly what this file prints when
 * node runs it, which is how the compiler knows the program it built is this
 * program. The statements here are also runnable as they are:
 *
 *   node src/examples/hello_world/main.ts
 */

import { dotProduct } from "./hello_world.ts";

const A = new Float64Array([1, 2, 3, 4]);
const B = new Float64Array([5, 6, 7, 8]);

console.log(`starting: dot product of ${A.length} elements`);

const total = dotProduct(A, B, A.length);

console.log(`done: dot product = ${total}`);

/**
 * The TOML parser the compiler reads a project with.
 *
 * The package's own entry point also offers the writer, and the writer reads
 * `globalThis.Temporal`: a name a compiled function has no value for. The
 * parser is the half this program uses, and it is read here directly so the
 * writer is not a module the self-build compiles.
 */
export { parse } from "../node_modules/smol-toml/dist/parse.js";

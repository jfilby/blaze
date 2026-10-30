/**
 * The host services the compiler asks for.
 *
 * A compiler source imports from here and not from a host's own modules. The
 * Node implementation is `platform-node.ts`, the one file that names a Node
 * module; a native compiler answers the same names from the native adapter it
 * is linked with.
 *
 * The names are the operations, not the host: a file is read, a process is
 * spawned, a hash is made. A caller passes the data the operation needs and
 * reads the data it answers, so the implementation can change without the
 * sources that ask changing.
 */

export {
  appendFile,
  availableParallelism,
  basename,
  copyFile,
  cpus,
  createHash,
  createInterface,
  dirname,
  existsSync,
  extname,
  fileURLToPath,
  isAbsolute,
  join,
  mkdir,
  mkdtemp,
  normalize,
  open,
  parseArgs,
  posix,
  randomUUID,
  readFile,
  readFileSync,
  readdir,
  relative,
  rename,
  resolve,
  rm,
  sep,
  setTimeout,
  sleep,
  spawn,
  spawnSync,
  stat,
  tmpdir,
  writeFile,
  writeFileSync,
} from "./platform-node.ts";

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

/** One of the command's own streams: a terminal or a pipe, and a write. */
export interface HostStream {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** A signal the command handles so a title does not outlive it. */
export type HostSignal = "SIGINT" | "SIGTERM";

/**
 * The process the command runs in, as the command line needs it.
 *
 * The arguments are the command's own, after the program and script names;
 * the streams are where a command writes what it says; and the exit code is
 * the answer the process leaves behind. Asking a question and handling a
 * signal are operations of the host because a native command has no
 * `readline` module and no Node signal emitter to reach for.
 */
export interface Host {
  readonly arguments: readonly string[];
  readonly stdout: HostStream;
  readonly stderr: HostStream;
  readonly platform: string;
  cwd(): string;
  setExitCode(code: number): void;
  /** The answer to one question, or undefined when there is nobody to ask. */
  ask(question: string): Promise<string | undefined>;
  /** Calls the handler when the process exits; the answer detaches it. */
  onExit(handler: () => void): () => void;
  /** Calls the handler once for a signal; the answer detaches it. */
  onSignal(signal: HostSignal, handler: () => void): () => void;
  /** Raises a signal again once its handler has settled what it was doing. */
  raiseSignal(signal: HostSignal): void;
}

/**
 * One entry a directory lists: its name, and what it is.
 *
 * The shape is the compiler's own rather than the host's: a source that lists
 * a directory asks whether an entry is a file or a directory, and a native
 * adapter answers the same two questions without carrying the host's type.
 */
export interface DirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * What a file is: its size in bytes, and whether it is a file or a directory.
 */
export interface FileInfo {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export {
  appendFile,
  availableParallelism,
  basename,
  compilerDataRoot,
  compilerSourceRoot,
  copyFile,
  cpus,
  createHash,
  createInterface,
  dirname,
  existsSync,
  extname,
  fileURLToPath,
  host,
  hostArchitecture,
  hostEnvironment,
  hostPlatform,
  isAbsolute,
  join,
  mkdir,
  mkdtemp,
  monotonicTimeNs,
  normalize,
  open,
  parseArgs,
  posix,
  processId,
  randomUUID,
  readFile,
  readFileSync,
  readdir,
  readdirEntries,
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

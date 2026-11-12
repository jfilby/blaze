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
 * The command a host runs to give a program a heap bound.
 *
 * A host that applies the bound before the program starts returns the program
 * and its arguments unchanged. A host that has to go through a wrapper returns
 * the wrapper and says what it writes when the program is missing, because
 * that wrapper's exit status is not the program's and the caller must not
 * read it as one.
 */
export interface BoundedCommand {
  readonly command: string;
  readonly args: string[];
  readonly missing?: string;
}

/** The output side of a child process: text, chunk by chunk. */
export interface HostReadable {
  setEncoding(encoding: string): void;
  on(event: string, handler: (chunk: string) => void): void;
}

/** The failure a child reports when it could not start or was stopped. */
export interface HostError {
  code?: string;
  message?: string;
}

/** The input side of a child process. */
export interface HostWritable {
  on(event: string, handler: (error: unknown) => void): void;
  end(text?: string): void;
}

/**
 * One child process, as the command that starts it reads it: the streams it
 * writes and the events that say how it ended.
 *
 * The shape is the boundary's own and not the host's: a build asks a child for
 * its output and for its close, and a host that has no asynchronous child is
 * simply without `spawn`, so the build runs its children in order.
 */
export interface HostChild {
  readonly stdout?: HostReadable | null;
  readonly stderr?: HostReadable | null;
  readonly stdin?: HostWritable | null;
  on(event: "error", handler: (error: HostError) => void): void;
  on(event: "close", handler: (status: number | null, signal: string | null) => void): void;
  kill(signal: string): void;
  readonly pid?: number;
}

/** What a child is started with, as the command that starts it names it. */
export interface HostSpawnOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdio?: readonly string[];
}

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
  /**
   * Calls the handler when the process exits; the answer detaches it. A host
   * that cannot hand its own exit to the program is without it, and a command
   * that decorates the terminal checks for it before it decorates anything.
   */
  onExit?(handler: () => void): () => void;
  /** Calls the handler once for a signal; the answer detaches it. */
  onSignal?(signal: HostSignal, handler: () => void): () => void;
  /** Raises a signal again once its handler has settled what it was doing. */
  raiseSignal?(signal: HostSignal): void;
  /**
   * Starts a child the caller can wait on without blocking the process. A host
   * without one still runs children: the build runs them one after another.
   */
  spawn?(command: string, args: readonly string[], options: HostSpawnOptions): HostChild;
  /** The command that runs a program with a bounded heap. */
  boundHeap(command: string, args: readonly string[], bytes: number): BoundedCommand;
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
  clearTimeout,
  compilerDataRoot,
  compilerSourceRoot,
  copyFile,
  cpus,
  createHash,
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
  spawnSync,
  stat,
  tmpdir,
  writeFile,
  writeFileSync,
} from "./platform-node.ts";

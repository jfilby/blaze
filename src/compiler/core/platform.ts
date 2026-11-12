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
 * The WebAssembly engine the host process carries, where it carries one.
 *
 * A build verifies a module's boundary in this process when the engine is
 * here, and asks a child process when it is not. The boundary names the
 * operations, not the host: a native command has no engine and answers null.
 */
export interface WebAssemblyEngine {
  validate(bytes: Uint8Array): boolean;
  Module: {
    new (bytes: Uint8Array): unknown;
    imports(module: unknown): { module: string; name: string; kind: string }[];
    exports(module: unknown): { name: string }[];
  };
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
  hostArchitecture,
  hostArguments,
  hostAsk,
  hostBoundHeap,
  hostCwd,
  hostEnvironment,
  hostOnExit,
  hostOnSignal,
  hostPlatform,
  hostRaiseSignal,
  hostSetExitCode,
  hostSpawn,
  hostSpawnSupport,
  hostStdoutIsTTY,
  hostWriteError,
  hostWriteOut,
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
  webAssemblyEngine,
  writeFile,
  writeFileSync,
} from "#host/platform";

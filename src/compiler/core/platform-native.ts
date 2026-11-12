/**
 * The native implementation of the host services the compiler asks for.
 *
 * This file is compiled by Blaze together with the rest of the compiler: it
 * names no host module and no host object, only the operations the runtime's
 * host ABI answers. The Node compiler never loads it (package.json maps
 * `#host/platform` to `core/platform-node.ts`); the self-build maps the same
 * boundary here (blaze.toml), so the binary the compiler writes is made of
 * sources the frontend reads.
 *
 * The two implementations answer the same names. A file is read, a path is
 * joined, a child is started: what changes is the body behind the name, which
 * is what the boundary is for. Where a host has no answer the function says so
 * with the value the interface allows — no WebAssembly engine, no asynchronous
 * child — and the build falls back to the answer a native command has.
 *
 * The command line is the one place a native compiler needs a service an
 * ordinary program does not: it reads a project file, a flag and a directory as
 * texts, while a program the source runs reads its arguments as numbers. The
 * runtime carries both, and this adapter reads the text one.
 */

import type {
  BoundedCommand,
  DirectoryEntry,
  FileInfo,
  HostChild,
  HostSignal,
  HostSpawnOptions,
  WebAssemblyEngine,
} from "./platform.ts";

/* -------------------------------------------------------------------------- */
/* The command line                                                            */
/* -------------------------------------------------------------------------- */

/** The arguments this process was given, as the texts they are. */
function argumentTexts(): string[] {
  const found: string[] = [];
  const count = hostArgumentCount();
  for (let at = 0; at < count; at += 1) {
    found.push(hostArgument(at));
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/** The separator a native path is written with. */
export const sep = "/";

/** A path with its empty and `.` parts taken out and its `..` parts folded. */
function normalizePath(path: string): string {
  if (path === "") return ".";
  const absolute = path.startsWith(sep);
  const parts = path.split(sep);
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
      else if (!absolute) kept.push(part);
      continue;
    }
    kept.push(part);
  }
  const joined = kept.join(sep);
  if (absolute) return sep + joined;
  return joined === "" ? "." : joined;
}

/** A path with its empty and `.` parts taken out and its `..` parts folded. */
export function normalize(path: string): string {
  return normalizePath(path);
}

/** Two or three path parts joined and normalized. */
export function join(first: string, second: string, third?: string): string {
  const parts: string[] = [];
  if (first !== "") parts.push(first);
  if (second !== "") parts.push(second);
  if (third !== undefined && third !== "") parts.push(third);
  return normalizePath(parts.join(sep));
}

/** A path made absolute against the directory the process runs in. */
export function resolve(path: string, second?: string): string {
  const first = path.startsWith(sep) ? normalizePath(path) : normalizePath(join(cwdPath(), path));
  if (second === undefined) return first;
  return second.startsWith(sep) ? normalizePath(second) : normalizePath(join(first, second));
}

/** The directory part of a path. */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === sep) return sep;
  const cut = normalized.lastIndexOf(sep);
  if (cut < 0) return ".";
  if (cut === 0) return sep;
  return normalized.slice(0, cut);
}

/** The last part of a path, with the suffix taken off where it is there. */
export function basename(path: string, suffix?: string): string {
  const normalized = normalizePath(path);
  const cut = normalized.lastIndexOf(sep);
  let name = cut < 0 ? normalized : normalized.slice(cut + 1);
  if (name === "") name = normalized === sep ? sep : ".";
  if (suffix !== undefined && suffix !== "" && name.endsWith(suffix) && name !== suffix) {
    name = name.slice(0, name.length - suffix.length);
  }
  return name;
}

/** The extension of a path, including the dot, or the empty text. */
export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot);
}

/** Whether a path is absolute. */
export function isAbsolute(path: string): boolean {
  return path.startsWith(sep);
}

/** The path that reaches `to` from `from`. */
export function relative(from: string, to: string): string {
  const left = resolve(from).split(sep);
  const right = resolve(to).split(sep);
  let common = 0;
  while (common < left.length && common < right.length && left[common] === right[common]) {
    common += 1;
  }
  const up: string[] = [];
  for (let at = common; at < left.length; at += 1) {
    if (left[at] !== "") up.push("..");
  }
  const rest = right.slice(common).filter((part) => part !== "");
  return up.concat(rest).join(sep);
}

/**
 * The path operations the compiler names under `posix`.
 *
 * The calls are the compiler's own builtins — `posix.join`, `posix.dirname`,
 * `posix.normalize` and `posix.extname` — so the object carries the separator a
 * path is written with and nothing else: a function held in a field would be a
 * value the source only ever calls.
 */
export const posix = { sep };

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/** The text of a file, as the mode asks. */
export async function readFile(path: string, _mode?: string): Promise<string> {
  return readTextFile(path, "utf8");
}

/** A file written with the text, replacing what it held. */
export async function writeFile(path: string, text: string, _mode?: string): Promise<void> {
  writeFileSync(path, text);
}

/** A file appended to, making it where it is not there yet. */
export async function appendFile(path: string, text: string, _mode?: string): Promise<void> {
  appendPath(path, text);
}

/** The text of a file, read without a child process. */
export function readFileSync(path: string, _mode?: string): string {
  return readTextFile(path, "utf8");
}

/** Writes a file without a child process. */
export function writeFileSync(path: string, text: string): void {
  fs.writeFileSync(path, text);
}

/** Whether the path names anything. */
export function existsSync(path: string): boolean {
  return fs.existsSync(path) !== 0;
}

/** The names of the entries directly inside a directory. */
export async function readdir(path: string): Promise<string[]> {
  const entries = await readdirEntries(path);
  const names: string[] = [];
  for (const entry of entries) names.push(entry.name);
  return names;
}

/** The entries of a directory, each with the two questions about it. */
export async function readdirEntries(path: string): Promise<DirectoryEntry[]> {
  const found: DirectoryEntry[] = [];
  const count = fs.dirCountSync(path);
  for (let at = 0; at < count; at += 1) {
    const name = fs.dirNameSync(path, at);
    const directory = fs.dirIsDirSync(path, at) !== 0;
    found.push({
      name,
      isFile: (): boolean => !directory,
      isDirectory: (): boolean => directory,
    });
  }
  return found;
}

/** What a file is: its size in bytes, and whether it is a file or a directory. */
export async function stat(path: string): Promise<FileInfo> {
  const kind = fs.fileKindSync(path);
  return {
    size: fs.fileSizeSync(path),
    isFile: (): boolean => kind === 1,
    isDirectory: (): boolean => kind === 2,
  };
}

/** A directory and the directories above it. */
export async function mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
  fs.mkdirSync(path, 1);
}

/** A directory made for one writer, named by the prefix and a unique suffix. */
export async function mkdtemp(prefix: string): Promise<string> {
  const root = tmpdir();
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const name = `${prefix}${processIdText()}-${attempt}`;
    const path = join(root, name);
    if (fs.mkdirSync(path, 0) !== 0) return path;
  }
  return join(root, prefix);
}

/** A file copied to another path. */
export async function copyFile(from: string, to: string): Promise<void> {
  fs.copyFileSync(from, to);
}

/** A file or directory moved to another path. */
export async function rename(from: string, to: string): Promise<void> {
  fs.renameSync(from, to);
}

/** A file or directory removed. */
export async function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
  fs.rmSync(path, options?.recursive === true ? 1 : 0);
}

/**
 * A file the compiler opened, and the two things it does with it: writes it
 * through to the disk and closes it. A native handle is the path itself: the
 * sync service opens the file and flushes it, and closing is nothing.
 */
export interface FileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Opens a file as the handle above. */
export async function open(path: string, _mode: string): Promise<FileHandle> {
  return {
    sync: async (): Promise<void> => {
      fs.fsyncPath(path);
    },
    close: async (): Promise<void> => {
      return;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The process and its host                                                    */
/* -------------------------------------------------------------------------- */

/** The operating system this compiler is running on. */
export function hostPlatform(): string {
  return os.platform();
}

/** The architecture this compiler is running on. */
export function hostArchitecture(): string {
  return os.arch();
}

/** The process id, which names the temporary files of one writer. */
export function processId(): number {
  return hostProcessId();
}

/** The id as the text a temporary name carries. */
function processIdText(): string {
  return `${processId()}`;
}

/** A clock that only moves forward, in nanoseconds. */
export function monotonicTimeNs(): bigint {
  return process.hrtime.bigint();
}

/** The variables the host process was given. */
export function hostEnvironment(): Readonly<Record<string, string | undefined>> {
  const found: Record<string, string | undefined> = {};
  const count = env.count();
  for (let at = 0; at < count; at += 1) {
    const item = env.at(at);
    const cut = item.indexOf("=");
    if (cut <= 0) continue;
    found[item.slice(0, cut)] = item.slice(cut + 1);
  }
  return found;
}

/** The directory a build reads its vendored sources from. */
export function compilerDataRoot(): string {
  return configuredRoot("BLAZE_DATA_ROOT");
}

/** The compiler's own source package, which its fingerprint walks. */
export function compilerSourceRoot(): string {
  return configuredRoot("BLAZE_SOURCE_ROOT");
}

/** The directory the environment names, or the one the process runs in. */
function configuredRoot(name: string): string {
  const value = envGet(name);
  if (value === undefined || value === "") return process.cwd();
  return resolve(value);
}

/** The temporary directory the host provides. */
export function tmpdir(): string {
  return os.tmpdir();
}

/** How many processors the host makes available. */
export function availableParallelism(): number {
  const count = os.cpuCount();
  return count > 0 ? count : 1;
}

/** The processors the host makes available, as the model a fingerprint reads. */
export function cpus(): { model: string }[] {
  return [{ model: hostArchitecture() }];
}

/** A wait of the milliseconds the call names. */
export async function sleep(milliseconds: number): Promise<void> {
  sleepMs(milliseconds);
}

/** The wait the host offers under the timer's name. */
export function setTimeout(milliseconds: number): Promise<void> {
  return sleep(milliseconds);
}

/** A wait that is already over has nothing to clear. */
export function clearTimeout(_handle: unknown): void {
  return;
}

/** A random UUID, which a build record carries. */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/**
 * The WebAssembly engine this process has, or null where it has none.
 *
 * A native command carries no engine: the boundary check asks a child process
 * instead, which is the answer the interface allows for one.
 */
export function webAssemblyEngine(): WebAssemblyEngine | null {
  return null;
}

/** The text a file URL names, percent escapes read. */
export function fileURLToPath(url: string): string {
  const prefix = "file://";
  const body = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  const parts = body.split("%");
  let text = parts[0] ?? "";
  for (let at = 1; at < parts.length; at += 1) {
    const part = parts[at] ?? "";
    const code = Number.parseInt(part.slice(0, 2), 16);
    text += String.fromCodePoint(code);
    text += part.slice(2);
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/** The hasher a chain reads: the runtime answers the digest. */
export interface Hash {
  update(text: string, encoding?: string): Hash;
  digest(encoding: string): string;
}

/**
 * The hasher the chain reads.
 *
 * A call of `createHash("sha256")` is lowered by the compiler to the runtime's
 * hasher, so the chain above never reaches this body: it is here because the
 * boundary exports the name, and a host that answered no hasher would not be
 * the interface the Node implementation answers.
 */
export function createHash(algorithm: string): Hash {
  throw new Error(`the ${algorithm} hasher is the runtime's own`);
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** What a completed command answers, in the shape the caller reads. */
export interface CommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: { code?: string; message?: string };
}

/** The environment a command is started with, as the pairs the runtime sets. */
function applyEnvironment(handle: number, environment: Readonly<Record<string, string | undefined>> | undefined): void {
  if (environment === undefined) return;
  for (const name of Object.keys(environment)) {
    const value = environment[name];
    if (value === undefined) continue;
    exec.env(handle, name, value);
  }
}

/** One command run to completion, in the shape `core/process.ts` reads. */
export function spawnSync(
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
    input?: string;
    encoding?: string;
    timeout?: number;
    killSignal?: string;
    maxBuffer?: number;
  },
): CommandResult {
  const handle = exec.new();
  exec.arg(handle, command);
  for (const argument of args) exec.arg(handle, argument);
  if (options?.cwd !== undefined) exec.cwd(handle, options.cwd);
  applyEnvironment(handle, options?.env);
  if (options?.input !== undefined) exec.input(handle, options.input);
  const timeout = options?.timeout === undefined ? 0 : options.timeout;
  const code = exec.run(handle, timeout);
  const stdout = exec.stdout(handle);
  const stderr = exec.stderr(handle);
  const errnum = exec.errno(handle);
  const timedOut = exec.timedOut(handle) !== 0;
  const signalNumber = exec.signal(handle);
  exec.free(handle);
  const signal = signalNumber === 0 ? null : `${signalNumber}`;
  const status = code < 0 ? null : code;
  if (timedOut) {
    return { status: null, signal, stdout, stderr, error: { code: "ETIMEDOUT", message: "the command was stopped at its deadline" } };
  }
  if (errnum !== 0) {
    return { status: null, signal, stdout, stderr, error: { code: "ENOENT", message: "the command could not be started" } };
  }
  return { status, signal, stdout, stderr };
}

/** The command that runs a program with a bounded heap. */
function boundedCommand(command: string, args: readonly string[], _bytes: number): BoundedCommand {
  // The runtime owns the heap of the programs it runs, so there is no wrapper
  // to put in front of one: the command is the command the caller asked for.
  return { command, args: [...args] };
}

/** The arguments the command was given, after the program and script names. */
export function hostArguments(): readonly string[] {
  return argumentTexts();
}

/** Whether the output stream is a terminal, which a title may decorate. */
export function hostStdoutIsTTY(): boolean {
  return streamIsTTY(1) !== 0;
}

/** Writes to the output stream, as it is given. */
export function hostWriteOut(text: string): void {
  stdoutWrite(text);
}

/** Writes to the error stream, as it is given. */
export function hostWriteError(text: string): void {
  process.stderr.write(text);
}

/** The directory the process runs in. */
export function hostCwd(): string {
  return process.cwd();
}

/** Sets the status the process leaves with. */
export function hostSetExitCode(code: number): void {
  setExitCode(code);
}

/** The answer to one question, or undefined when there is nobody to ask. */
export async function hostAsk(question: string): Promise<string | undefined> {
  stdoutWrite(question);
  return readLine();
}

/** A detach that has nothing to detach: the native process owns no handlers. */
function noDetach(): void {
  return;
}

/** Calls the handler when the process exits; the native host has no exit hook. */
export function hostOnExit(_handler: () => void): () => void {
  return noDetach;
}

/** Calls the handler once for a signal; the native host has no signal hook. */
export function hostOnSignal(_signal: HostSignal, _handler: () => void): () => void {
  return noDetach;
}

/** The native host has no signal of its own to raise again. */
export function hostRaiseSignal(_signal: HostSignal): void {
  return;
}

/** Whether the host can start a child without blocking the process. */
export function hostSpawnSupport(): boolean {
  return false;
}

/** Starts a child the caller can wait on without blocking the process. */
export function hostSpawn(_command: string, _args: readonly string[], _options: HostSpawnOptions): HostChild {
  throw new Error("this host runs its children one after another");
}

/** The command that runs a program with a bounded heap. */
export function hostBoundHeap(command: string, args: readonly string[], bytes: number): BoundedCommand {
  return boundedCommand(command, args, bytes);
}

/* -------------------------------------------------------------------------- */
/* The command line reader                                                     */
/* -------------------------------------------------------------------------- */

/** The option table the compiler's command line states. */
interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
}

/** What one command line parsed to. */
export interface ParsedArguments {
  values: Record<string, string | boolean>;
  positionals: string[];
}

/**
 * Node's `parseArgs`, for the options the compiler's command line states.
 *
 * A long option is `--name value`, `--name=value` or, for a flag, `--name`;
 * a short option is `-h`. The first positional and everything after it are the
 * command and its arguments, and `--` ends the options.
 */
export function parseArgs(configuration: {
  args: readonly string[];
  allowPositionals?: boolean;
  options?: Record<string, OptionSpec>;
}): ParsedArguments {
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const options = configuration.options ?? {};
  const args = configuration.args;
  let at = 0;
  while (at < args.length) {
    const argument = args[at] as string;
    at += 1;
    if (argument === "--") {
      while (at < args.length) {
        positionals.push(args[at] as string);
        at += 1;
      }
      break;
    }
    if (!argument.startsWith("-") || argument === "-") {
      positionals.push(argument);
      continue;
    }
    const long = argument.startsWith("--");
    const body = long ? argument.slice(2) : argument.slice(1);
    const equal = body.indexOf("=");
    const name = equal < 0 ? body : body.slice(0, equal);
    const inline = equal < 0 ? undefined : body.slice(equal + 1);
    let key = name;
    let spec = options[key];
    if (spec === undefined && !long) {
      for (const candidate of Object.keys(options)) {
        const declared = options[candidate];
        if (declared !== undefined && declared.short === name) {
          key = candidate;
          spec = declared;
          break;
        }
      }
    }
    if (spec === undefined) continue;
    if (spec.type === "boolean") {
      values[key] = true;
      continue;
    }
    if (inline !== undefined) {
      values[key] = inline;
      continue;
    }
    if (at < args.length) {
      values[key] = args[at] as string;
      at += 1;
    }
  }
  return { values, positionals };
}

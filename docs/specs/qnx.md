# The QNX port

## What this spec is

This is the roadmap for Blaze on QNX OS 8.0. It starts from the assumption that
self-hosting is already achieved: a native `blaze` binary builds and runs on the
Linux development host, `core/platform.ts` has a native adapter behind it, the
Node-only packages have been replaced, and the compiler builds itself to a fixed
point on that host.

This spec does not re-plan the Linux self-host work. It plans the two things
that are left for QNX:

- the compiler runs on QNX;
- the compiler builds QNX programs, and builds itself on QNX.

Cross-building QNX binaries from Linux is the bootstrap path. It produces the
first QNX `blaze`, and that binary builds its own successor on the target.

The reference targets are:

| Target | QNX name | Compiler host | First backend |
|---|---|---|---|
| x86-64 | `x86_64` | QNX OS 8.0 x86-64 | machine, then C |
| AArch64 | `aarch64le` | QNX OS 8.0 AArch64 | C |

QNX SDP 8.0 is a cross-development environment driven by `qcc`. The QNX
self-hosted developer desktop provides `clang` for C and C++ and does not
provide `qcc`. The port must support both toolchains rather than assume one.

## Definition of done

The QNX port is achieved when all of the following hold.

1. `blaze` runs on QNX OS 8.0 x86-64 and AArch64.
2. It builds C-backend programs for both targets. On x86-64 it also builds
   machine-backend programs.
3. Built programs run on QNX and pass the QNX conformance suite: files,
   processes, clocks, hashes, HTTP, SQLite, and the generated-code ABI.
4. The bootstrap fixed point holds:
   - `blaze-host` cross-builds `blaze-qnx-1`;
   - `blaze-qnx-1` builds `blaze-qnx-2` from `src/compiler`;
   - `blaze-qnx-2` builds `blaze-qnx-3` from the same tree;
   - `blaze-qnx-2` and `blaze-qnx-3` agree on the conformance corpus.
5. No Node, no bash-only tool, and no Linux-only syscall is required at runtime.
6. CI runs the Linux test suite, the cross QNX builds, and the QNX conformance
   suite under QEMU or on hardware.
7. The install story is documented: the binary, its vendored sources, the
   target fields, unsupported facilities, and the verification modes.

## The bootstrap ladder

| Stage | Built by | Runs on | Toolchain |
|---|---|---|---|
| `blaze-host` | the existing self-hosted compiler on Linux | Linux | host `gcc`/`clang` |
| `blaze-qnx-1` | `blaze-host`, target `qnx-x86_64` | QNX x86-64 | `qcc -Vgcc_ntox86_64` |
| `blaze-qnx-2` | `blaze-qnx-1` | QNX x86-64 | `clang` |
| `blaze-qnx-3` | `blaze-qnx-2` | QNX x86-64 | `clang` |

The AArch64 ladder is the same with `qcc -Vgcc_ntoaarch64le` and the AArch64
`clang`. The first QNX binary has to be cross-built because there is no Blaze
binary on the target yet; the QNX toolchain itself exists. Every later stage is
built on the target.

The fixed point is the one in `docs/specs/self-hosting.md`: byte-for-byte
equality of the binaries is not required, but the command exit status, stdout,
stderr, IR text, build records, selected candidates, delivered-program output,
and refusal messages must agree.

## Milestones

### 0. Target and toolchain scaffolding

**Work**

- Add `"qnx"` to `OsName` in `src/compiler/core/types.ts`. Add the AArch64 ABI
  value needed by the C backend (for example `"aapcs"`); x86-64 stays `"sysv"`.
- Extend `src/compiler/core/target.ts`:
  - the operating-system list and `normalizeTarget`;
  - `assertBuildableTarget` so QNX is accepted;
  - `cTargetOptions`: never pass `-mtune=native` to a cross compiler, and pass
    `-march` only when the selected toolchain accepts it;
  - target summary and executable naming for QNX.
- Introduce a toolchain descriptor, for example `src/compiler/core/toolchain.ts`,
  selected by host and target. It must answer:
  - the compiler and target selector (`gcc`, `clang`, `qcc -V...`);
  - compile, assemble, link, and relocatable-link argv;
  - whether the toolchain supports LTO, fat LTO, OpenMP, assembly delivery,
    `--gc-sections`, static linking, and a separate assembler/linker.
- Replace hardcoded `gcc`, `as --64`, and `ld -r` calls with the descriptor:
  - `src/compiler/toolchain/linker.ts`
  - `src/compiler/toolchain/driver.ts`
  - `src/compiler/toolchain/ir-c.ts`
  - `src/compiler/toolchain/csource.ts`
  - `src/compiler/runtime/standalone.ts`
  - `src/compiler/runtime/facil.ts`
  - `src/compiler/runtime/sqlite-build.ts`
  - `src/compiler/runtime/model-build.ts`
  - `src/compiler/runtime/sglang-build.ts`
  - `src/compiler/runtime/triton-build.ts`
- Define the profiles:
  - Linux host: `gcc` or `clang`, as today.
  - QNX cross: `qcc -Vgcc_ntox86_64` and `qcc -Vgcc_ntoaarch64le`, with
    `QNX_TARGET` from `qnxsdp-env.sh`.
  - QNX native: `clang` and `clang++`.
- Make the flags honest:
  - `-flto` only when the profile supports it;
  - `-ffat-lto-objects` only for GCC; if the QNX compiler has no fat LTO,
    disable LTO for QNX so candidate sizes still measure machine code;
  - `-fopenmp` only when the profile has an OpenMP runtime;
  - use the compiler driver for assembly, or the profile's assembler, instead
    of `as --64`;
  - use `ld.lld -r` or the driver's relocatable link instead of bare `ld -r`;
  - `-Wl,--gc-sections` only when the linker supports it.
- Make the runtime object cache identity include the selected compiler and
  target, not only the host.

**Exit criteria**

- A generated C object for a trivial function compiles with both `qcc` profiles
  and with QNX `clang`.
- `blaze-host` can select `qnx-x86_64` and `qnx-aarch64le` and reports the
  selected toolchain in the build record.
- No compiler path or flag set is chosen by a hardcoded tool name outside the
  toolchain descriptor.

**Tests**

- Unit tests for target normalization, rejection, and toolchain selection.
- A build-record test showing the QNX target and toolchain.
- A cross-compile smoke test that produces a QNX object with `qcc`.

### 1. Runtime and program execution

**Work**

- Compile `src/compiler/runtime/abi.ts` with the QNX toolchain. It is mostly
  POSIX C, but QNX-specific header work is expected:
  - `aligned_alloc` is declared in `<malloc.h>` on QNX;
  - keep `_POSIX_C_SOURCE` as the runtime sets it;
  - verify `clock_gettime`, `pthread_*`, `gmtime_r`, `strftime`, `getenv`.
- Port `src/compiler/runtime/facil.ts`:
  - QNX selects facil.io's `poll` engine automatically because it is neither
    Linux nor BSD;
  - verify `accept4`, `socketpair`, `strdup`, `sysconf`, and the poll path;
  - replace the `sh -c find` source enumeration with the platform adapter's
    directory walk, so a target needs no shell;
  - decide the TLS provider: OpenSSL if `libssl`/`libcrypto` are available for
    QNX, otherwise a qcrypto/gnutls backend, with the same `blaze_http` ABI;
  - verify `-lssl -lcrypto` (or the chosen libraries) and `-pthread`.
- Port `src/compiler/runtime/sqlite-build.ts`:
  - the vendored amalgamation already has `__QNXNTO__` paths;
  - compile with the QNX profile and no LTO;
  - verify `-pthread` and the SQLite thread mode.
- Port `src/compiler/runtime/standalone.ts`:
  - compile the cached runtime with the QNX profile;
  - include the target and compiler identity in the cache key;
  - verify `-ffunction-sections`, `-fdata-sections`, and `-lm`.
- Declare the unsupported runtime kinds on QNX:
  - `nim` requires a Nim compiler that QNX does not provide;
  - model, sglang, and triton runtimes are out of scope for the first port and
    must fail with a clear diagnostic rather than a linker error.

**Exit criteria**

- A C-backend program builds, links, and runs on QNX x86-64.
- A program using `--runtime facil` serves HTTP on QNX and answers correctly.
- A program using SQLite creates, writes, and reads a database on QNX.
- A program using files, processes, clocks, hashes, and random values passes the
  runtime probes on QNX.

**Tests**

- The existing C runtime probe suite compiled with the QNX toolchain and run
  under QEMU or on hardware.
- HTTP keep-alive, chunked bodies, and TLS (if enabled) on QNX.
- SQLite ABI and program tests on QNX.
- A negative test: `runtime: nim` on QNX is refused with a target diagnostic.

### 2. x86-64 machine backend on QNX

**Work**

- `assertMachineTarget` already accepts `x86_64 + sysv` regardless of OS, so
  no code change is expected there. Add a test that `qnx-x86_64` is admitted,
  and keep the refusal for AArch64 and non-SysV ABIs.
- Verify the ELF object the backend writes is accepted by the QNX linker:
  - ELF OSABI, `.note.GNU-stack`, `R_X86_64_PLT32` and `R_X86_64_PC32`;
  - default PIE versus non-PIE executable linking;
  - static and dynamic linking.
- Run the generated-code ABI harness on QNX:
  - integer and SSE argument registers;
  - 16-byte stack alignment at calls;
  - `f32`/`f64`, `i256`/`u256`, wide returns;
  - callbacks, variadic runtime helpers, and pthread-backed parallel loops.
- Verify LTO interaction: machine objects are ELF, C runtime objects may be
  LTO. If the QNX compiler cannot mix them, disable LTO for QNX target builds.
- Verify the benchmark and probe paths execute QNX binaries on QNX.

**Exit criteria**

- A machine-backend program on QNX x86-64 produces the same output as the C
  backend and the source oracle.
- The ABI harness passes on QNX.
- `blaze build` selects and delivers machine-backend objects on QNX x86-64.

**Tests**

- The existing machine-backend, u256, calls, recursion, and parallelism tests
  run on QNX.
- A linker test for static and dynamic QNX executables.
- A PIE test if the QNX toolchain defaults to PIE.

### 3. QNX host adapter and cross-built stage 1

**Work**

- Implement the QNX adapter for the boundary, for example
  `src/compiler/core/platform-qnx.ts`:
  - files: read, write, append, stat, list, mkdir, rename, remove, open/fsync;
  - directories: `DirectoryEntry` with a `stat` fallback if `d_type` is not
    populated;
  - processes: `posix_spawn` or `fork`/`exec`, argv, env, cwd, pipes, wait,
    timeout, kill, output cap;
  - the process itself: argv, env, cwd, stdin, stdout, stderr, `isatty`, exit;
  - time, monotonic clock, random, SHA-256, UUID;
  - paths, temp directory, and URL-to-path work;
  - network: HTTP client with TLS for model providers.
- Select the QNX adapter in the native build. `core/platform.ts` currently
  re-exports `platform-node.ts`; the native branch must be able to name
  `platform-qnx.ts` without a Node import.
- Replace the shell-based heap bound in `src/compiler/core/process.ts`. The
  current `/bin/sh` + `ulimit -d` wrapper is Linux-shell-shaped; set the limit
  in the child on QNX with `setrlimit`, and preserve the existing `RunResult`
  semantics for timeout, signal, missing program, and output cap.
- Move the remaining `process.*` use in `src/compiler/cli.ts` behind the
  boundary: `stdout.isTTY`, `stdout.write`, `stdin`, `cwd`, `argv`, `exitCode`,
  and the platform name.
- Settle the compiler's own source root and fingerprint:
  - `core/version.ts` derives the package root from `import.meta.url` and walks
    the compiler's sources;
  - a native QNX binary either reads an installed source tree or embeds the
    fingerprint at build time;
  - `blaze inspect` must report the same source identity after a rebuild.
- Package the data a build reads at run time:
  - `deps/facil.io` and `deps/sqlite3` are read from the compiler's repository
    root by `runtime/facil.ts` and `runtime/sqlite-build.ts`;
  - install those trees beside the binary, or embed them, and document the
    layout;
  - remove the `sh`/`find` dependency from `runtime/facil.ts`.
- Port the AI transport:
  - the native compiler already has an HTTP+TLS adapter; QNX needs the TLS
    provider and CA certificates;
  - `--model replay` must work with no network and no TLS;
  - provider review is allowed to be unavailable on a TLS-less QNX image, but
    the failure must be explicit.

**Exit criteria**

- `blaze-qnx-1 --help`, `blaze projects`, `blaze inspect`, and `blaze ir` run on
  QNX with no Node and no bash-only tool.
- `blaze-qnx-1 build --model replay` builds a C-backend program on QNX.
- The program runs on QNX and its output matches the source oracle.
- A model request over TLS succeeds on an image that has the chosen TLS
  provider; without one, replay still works and review fails clearly.

**Tests**

- Boundary tests that run on QNX: file operations, directory listing, spawn,
  timeout, missing program, stdout/stderr capture, exit status, TTY detection.
- A test that `blaze` runs with `PATH` containing only the QNX toolchain.
- A test that the vendored source layout is found from the installed binary.
- A test that `--model replay` works with networking disabled.

### 4. Self-host fixed point on QNX

**Work**

- Make the compiler's own project file target-aware. `src/compiler/blaze.toml`
  currently names `machine`; on AArch64 the self-build must use the C backend,
  and on x86-64 it may use machine.
- Cross-build `blaze-qnx-1` from `blaze-host`:
  - target `qnx-x86_64` or `qnx-aarch64le`;
  - backend `c` for the first bootstrap, machine for x86-64 once milestone 2 is
    complete;
  - runtime `none`.
- Run `blaze-qnx-1` on QNX and have it build `blaze-qnx-2` from the same tree.
- Have `blaze-qnx-2` build `blaze-qnx-3`.
- Compare stage 2 and stage 3 on the conformance corpus:
  - command exit status, stdout, and stderr;
  - `blaze ir` for every fixture;
  - build records, selected candidate, and delivered-program output;
  - a source the frontend refuses is refused by both with the same message and
    detail.
- Define the QNX conformance suite. The existing Node test suite cannot run on
  QNX; keep it as the Linux host suite, and add a target suite that is a shell
  script or a Blaze-built program and compares the same observables.
- Record performance for the self-build and a small benchmark set. No
  performance gate is required for the first fixed point.

**Exit criteria**

- `blaze-qnx-1` runs on QNX and builds `blaze-qnx-2`.
- `blaze-qnx-2` builds `blaze-qnx-3`.
- Stage 2 and stage 3 agree on the full corpus.
- The QNX conformance suite passes on x86-64, and on AArch64 with the C backend.

**Tests**

- The bootstrap ladder is a CI job, not a manual run.
- A clean checkout builds stage 1 from Linux and stages 2 and 3 on QNX.
- A deliberate frontend refusal produces identical diagnostics in all stages.

### 5. AArch64

**Work**

- Add the AArch64 QNX target: `arch: "aarch64"`, `os: "qnx"`, and the AArch64
  ABI value.
- Use the C backend for the first AArch64 port. The machine backend is x86-64
  only and is not required for the first QNX fixed point.
- Audit `char` signedness in generated C and in the runtime. AArch64 defaults
  to unsigned `char` in many toolchains; QNX may follow. Fix the generated code
  or pass the toolchain's signed-char option, and test it.
- Cross-build with `qcc -Vgcc_ntoaarch64le`; native-build with `clang` on the
  QNX AArch64 desktop.
- Run the same runtime, HTTP, SQLite, and conformance suites on AArch64.
- Record the machine-backend decision separately. Adding an AArch64 encoder is
  not part of this spec.

**Exit criteria**

- A C-backend program builds and runs on QNX AArch64.
- The compiler self-hosts on QNX AArch64 with the C backend and reaches the
  fixed point.
- The AArch64 conformance suite passes.

**Tests**

- Char-signedness tests for generated C and runtime string handling.
- The full QNX conformance suite on AArch64 hardware or QEMU.
- A negative test: machine backend on AArch64 is refused with a clear target
  diagnostic until an encoder exists.

### 6. Packaging, CI, and hardening

**Work**

- Distribution:
  - the `blaze` binary;
  - the vendored `deps/facil.io` and `deps/sqlite3` trees, or the embedded
    equivalents;
  - the target/toolchain documentation;
  - the verification-mode documentation.
- CI:
  - Linux: the full Node test suite and cross QNX builds;
  - QNX x86-64: QEMU or hardware, running the QNX conformance suite and the
    bootstrap ladder;
  - QNX AArch64: QEMU or hardware, running the C-backend conformance suite;
  - a job that checks the QNX binary has no dynamic dependency that is not
    documented.
- Verification policy:
  - `--verify=source` requires `node` for TypeScript and `python3` for Python;
  - `--verify=compare` compares two builds or a stage against a trusted stage;
  - `--verify=none` is explicit and is recorded in the build record;
  - the QNX default must not silently claim a source verification it did not
    run.
- Documentation:
  - `[target]` fields for QNX;
  - supported backends and runtime kinds;
  - TLS and model-review support;
  - the bootstrap and fixed-point procedure;
  - known unsupported facilities.

**Exit criteria**

- A QNX image can install the compiler and build a program with no Linux host.
- CI proves the cross build, the native run, and the fixed point.
- The documented limitations match the diagnostics.

## Cross-cutting decisions

### Verification without Node

The current `toolchain/verify-program.ts` runs TypeScript under `node` and
Python under `python3`. QNX has no Node. The port therefore needs three
verification modes, and a QNX build must say which one it used:

| Mode | Oracle | Available on QNX |
|---|---|---|
| `source` | `node` for TypeScript, `python3` for Python | Python only, unless Node is installed separately |
| `compare` | another trusted build or stage | yes |
| `none` | the build record only | yes |

The self-host fixed point uses `compare` for the compiler and the QNX
conformance suite. A user program built on QNX without an oracle is still
built, but the build record must not say it was source-verified.

### Cross and native execution

A cross-built QNX binary cannot run on the Linux build host. The target runner
needs one of:

- QEMU with a QNX image;
- SSH to QNX hardware;
- a local QNX host when Blaze itself runs on QNX.

The runner belongs behind the existing process boundary, so probes, benchmarks,
and program verification do not each grow a QNX special case.

### What stays out of scope

- Running Node on QNX. Node's supported platform list does not include QNX, and
  a port would need V8, libuv, ICU, OpenSSL, and the Node platform layer. The
  native compiler removes the need for it.
- An AArch64 machine-code backend. The C backend covers the first AArch64 port.
- WASM execution on QNX. The current host runner is Node-based; the wasm output
  kind stays unavailable until a native wasm runtime is added.
- Nim, Triton, SGLang, and model runtimes on QNX.
- Performance parity with the Linux host. Correctness and the fixed point come
  first.
- Cross-building from a QNX host to a different architecture without a cross
  toolchain.

## Risks and open questions

- **x86-64 ABI conformance.** Blaze emits System V AMD64 objects. QNX x86-64 is
  GCC/Clang-based, but the register/stack rules, red zone, varargs, and
  relocations must be proven by the ABI harness, not assumed.
- **Toolchain differences.** QNX `qcc` is GCC-based; the QNX desktop uses
  `clang`. LTO, fat LTO, OpenMP, `as`, `ld -r`, PIE defaults, and
  `--gc-sections` may differ. Every capability is a profile field, never a
  guess.
- **TLS.** facil.io's TLS backend is OpenSSL. QNX offers qcrypto and has
  gnutls/s2n ports, but the availability of `libssl`/`libcrypto` on the target
  image must be settled before model review is promised.
- **Test oracle.** The Node test suite cannot run on QNX. The QNX conformance
  suite must be a first-class deliverable, not a manual smoke test.
- **Vendored sources at run time.** facil.io and SQLite are read from `deps/`
  by the compiler. A native install must carry them, or the compiler must embed
  them.
- **Vendored source discovery.** `runtime/facil.ts` uses `sh -c find` today.
  QNX has a shell and `find`, but a target-only install should not depend on
  them; use the platform directory walk.
- **Heap bounds.** `core/process.ts` uses `/bin/sh` and `ulimit -d`. QNX's
  shell and resource limits may not behave the same. Set the limit with
  `setrlimit` in the spawned child and test that a runaway program is stopped.
- **AArch64 `char` signedness.** Generated C and runtime code must not depend
  on the host compiler's default.
- **Filesystem details.** `readdir` entry type, `fsync`, rename semantics, and
  case sensitivity need tests on the QNX filesystem in use.
- **Self-host source identity.** The native compiler must either read its
  installed sources or embed the fingerprint. `blaze inspect` and incremental
  reuse must agree with the choice.

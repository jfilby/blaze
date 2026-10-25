/**
 * The blaze Sglang/kernel runtime ABI.
 *
 * The boundary is one table, and everything else is generated from it: the C
 * header a program includes, the allowlist the sandboxes admit, and the
 * implementation that answers the entry points. The shape is the shape of
 * `runtime/http.ts` and `runtime/sqlite.ts`, so the two sides of it cannot
 * drift.
 */

export const SGLANG_NAME = "blaze_sglang";

/** One entry point of the Sglang ABI. */
export interface SglangEntry {
  symbol: string;
  returns: string;
  params: readonly (readonly [name: string, type: string])[];
  summary: string;
  ownership: string;
  noreturn?: boolean;
}

function sglangEntry(
  symbol: string,
  returns: string,
  params: readonly (readonly [string, string])[],
  summary: string,
  ownership: string,
  extra: { noreturn?: boolean } = {},
): SglangEntry {
  return { symbol, returns, params, summary, ownership, ...extra };
}

/**
 * The Sglang ABI. Every entry is implemented by the adapter
 * (`runtime/sglang-build.ts`) and declared in the generated `blaze_sglang.h`.
 * Nothing here names device-specific types: a program that links only the
 * compiler runtime never sees these declarations.
 */
export const SGLANG_ABI: readonly SglangEntry[] = [
  sglangEntry(
    "blaze_sglang_device_init",
    "int",
    [],
    "Initializes the device for kernel execution.",
    "Returns 1 on success, 0 on failure.",
  ),
  sglangEntry(
    "blaze_sglang_device_sync",
    "void",
    [],
    "Synchronizes the device stream.",
    "Blocks until all queued work is complete.",
  ),
  sglangEntry(
    "blaze_sglang_malloc",
    "void*",
    [["bytes", "size_t"]],
    "Allocates device memory.",
    "Returns an owned device pointer; null on failure.",
  ),
  sglangEntry(
    "blaze_sglang_free",
    "void",
    [["ptr", "void*"]],
    "Frees device memory.",
    "The pointer is no longer valid after this.",
  ),
  sglangEntry(
    "blaze_sglang_memcpy_h2d",
    "int",
    [
      ["dst", "void*"],
      ["src", "const void*"],
      ["bytes", "size_t"],
    ],
    "Copies memory from host to device.",
    "Returns 1 on success, 0 on failure.",
  ),
  sglangEntry(
    "blaze_sglang_memcpy_d2h",
    "int",
    [
      ["dst", "void*"],
      ["src", "const void*"],
      ["bytes", "size_t"],
    ],
    "Copies memory from device to host.",
    "Returns 1 on success, 0 on failure.",
  ),
  sglangEntry(
    "blaze_sglang_launch",
    "int",
    [
      ["kernel_name", "const char*"],
      ["grid_x", "unsigned long long"],
      ["grid_y", "unsigned long long"],
      ["grid_z", "unsigned long long"],
      ["block_x", "unsigned long long"],
      ["block_y", "unsigned long long"],
      ["block_z", "unsigned long long"],
      ["args", "const void* const*"],
      ["arg_sizes", "const size_t*"],
      ["num_args", "size_t"],
      ["shared_mem", "size_t"],
    ],
    "Launches a kernel.",
    "Returns 1 on success, 0 on failure.",
  ),
];

/** Symbols generated Sglang/kernel code may reference. Nothing else resolves at link time. */
export const SGLANG_SYMBOLS: Record<string, true> = Object.fromEntries(
  SGLANG_ABI.map((item) => [item.symbol, true as const]),
);

/** True when generated code is allowed to reference a Sglang symbol. */
export function isSglangSymbol(symbol: string): boolean {
  return SGLANG_SYMBOLS[symbol] === true;
}

const SGLANG_HEADER_PREAMBLE = `#ifndef BLAZE_SGLANG_H
#define BLAZE_SGLANG_H

#include <stddef.h>
#include <stdint.h>

/*
 * The blaze Sglang/kernel runtime ABI. Every handle is an opaque pointer:
 * device types never appear here, and a program that links only the compiler
 * runtime never sees this header.
 */
`;

const SGLANG_HEADER_EPILOGUE = `
#endif
`;

/** The C header a program that uses the Sglang runtime includes. */
export function sglangHeaderSource(): string {
  const declarations = SGLANG_ABI.map((item) => {
    const suffix = item.noreturn === true ? " /* never returns */" : "";
    return `${item.returns === "void" ? "void" : item.returns} ${item.symbol}(${
      item.params.length === 0 ? "void" : item.params.map(([name, type]) => `${type} ${name}`).join(", ")
    })${suffix};`;
  }).join("\n");
  return `${SGLANG_HEADER_PREAMBLE}\n${declarations}\n\n${SGLANG_HEADER_EPILOGUE}`;
}

/** True when a source uses Sglang/kernel facilities. */
export function usesSglangSource(source: string): boolean {
  return /@sglang\.jit|\btl\.(load|store|program_id|num_programs|arange|full|zeros|ones)|sglang\.language|kernel\[.*\]/.test(source);
}

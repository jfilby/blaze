/**
 * The blaze Triton/kernel runtime ABI.
 *
 * The boundary is one table, and everything else is generated from it: the C
 * header a program includes, the allowlist the sandboxes admit, and the
 * implementation that answers the entry points. The shape is the shape of
 * `runtime/http.ts` and `runtime/sqlite.ts`, so the two sides of it cannot
 * drift.
 */

export const TRITON_NAME = "blaze_triton";

/** One entry point of the Triton ABI. */
export interface TritonEntry {
  symbol: string;
  returns: string;
  params: readonly (readonly [name: string, type: string])[];
  summary: string;
  ownership: string;
  noreturn?: boolean;
}

function tritonEntry(
  symbol: string,
  returns: string,
  params: readonly (readonly [string, string])[],
  summary: string,
  ownership: string,
  extra: { noreturn?: boolean } = {},
): TritonEntry {
  return { symbol, returns, params, summary, ownership, ...extra };
}

/**
 * The Triton ABI. Every entry is implemented by the adapter
 * (`runtime/triton-build.ts`) and declared in the generated `blaze_triton.h`.
 * Nothing here names device-specific types: a program that links only the
 * compiler runtime never sees these declarations.
 */
export const TRITON_ABI: readonly TritonEntry[] = [
  tritonEntry(
    "blaze_triton_device_init",
    "int",
    [],
    "Initializes the device for kernel execution.",
    "Returns 1 on success, 0 on failure.",
  ),
  tritonEntry(
    "blaze_triton_device_sync",
    "void",
    [],
    "Synchronizes the device stream.",
    "Blocks until all queued work is complete.",
  ),
  tritonEntry(
    "blaze_triton_malloc",
    "void*",
    [["bytes", "size_t"]],
    "Allocates device memory.",
    "Returns an owned device pointer; null on failure.",
  ),
  tritonEntry(
    "blaze_triton_free",
    "void",
    [["ptr", "void*"]],
    "Frees device memory.",
    "The pointer is no longer valid after this.",
  ),
  tritonEntry(
    "blaze_triton_memcpy_h2d",
    "int",
    [
      ["dst", "void*"],
      ["src", "const void*"],
      ["bytes", "size_t"],
    ],
    "Copies memory from host to device.",
    "Returns 1 on success, 0 on failure.",
  ),
  tritonEntry(
    "blaze_triton_memcpy_d2h",
    "int",
    [
      ["dst", "void*"],
      ["src", "const void*"],
      ["bytes", "size_t"],
    ],
    "Copies memory from device to host.",
    "Returns 1 on success, 0 on failure.",
  ),
  tritonEntry(
    "blaze_triton_launch",
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

/** Symbols generated Triton/kernel code may reference. Nothing else resolves at link time. */
export const TRITON_SYMBOLS: Record<string, true> = Object.fromEntries(
  TRITON_ABI.map((item) => [item.symbol, true as const]),
);

/** True when generated code is allowed to reference a Triton symbol. */
export function isTritonSymbol(symbol: string): boolean {
  return TRITON_SYMBOLS[symbol] === true;
}

const TRITON_HEADER_PREAMBLE = `#ifndef BLAZE_TRITON_H
#define BLAZE_TRITON_H

#include <stddef.h>
#include <stdint.h>

/*
 * The blaze Triton/kernel runtime ABI. Every handle is an opaque pointer:
 * device types never appear here, and a program that links only the compiler
 * runtime never sees this header.
 */
`;

const TRITON_HEADER_EPILOGUE = `
#endif
`;

/** The C header a program that uses the Triton runtime includes. */
export function tritonHeaderSource(): string {
  const declarations = TRITON_ABI.map((item) => {
    const suffix = item.noreturn === true ? " /* never returns */" : "";
    return `${item.returns === "void" ? "void" : item.returns} ${item.symbol}(${
      item.params.length === 0 ? "void" : item.params.map(([name, type]) => `${type} ${name}`).join(", ")
    })${suffix};`;
  }).join("\n");
  return `${TRITON_HEADER_PREAMBLE}\n${declarations}\n\n${TRITON_HEADER_EPILOGUE}`;
}

/** True when a source uses Triton/kernel facilities. */
export function usesTritonSource(source: string): boolean {
  return /@triton\.jit|\btl\.(load|store|program_id|num_programs|arange|full|zeros|ones)|triton\.language|kernel\[.*\]/.test(source);
}

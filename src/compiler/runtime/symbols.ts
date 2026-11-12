/**
 * The symbols generated code may reference.
 *
 * The ABI lists are read as the values the modules hold: a table built at the
 * module's top is state a compiled function owns no copy of, so membership is
 * asked of the lists themselves rather than of a table derived from them.
 */

import { RUNTIME_ABI, TEXT_SYMBOLS, WIDE_SYMBOLS } from "./abi.ts";
import { HTTP_ABI } from "./http.ts";
import { SQLITE_ABI } from "./sqlite.ts";
import { TRITON_ABI } from "./triton.ts";
import { MODEL_ABI } from "./model.ts";
import { SGLANG_ABI } from "./sglang.ts";

/** True when generated code is allowed to reference a symbol. */
export function isRuntimeSymbol(symbol: string): boolean {
  for (const item of RUNTIME_ABI) {
    if (item.symbol === symbol) return true;
  }
  if (WIDE_SYMBOLS[symbol] === true) return true;
  if (TEXT_SYMBOLS[symbol] === true) return true;
  for (const item of HTTP_ABI) {
    if (item.symbol === symbol) return true;
  }
  for (const item of SQLITE_ABI) {
    if (item.symbol === symbol) return true;
  }
  for (const item of TRITON_ABI) {
    if (item.symbol === symbol) return true;
  }
  for (const item of MODEL_ABI) {
    if (item.symbol === symbol) return true;
  }
  for (const item of SGLANG_ABI) {
    if (item.symbol === symbol) return true;
  }
  return false;
}

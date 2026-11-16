/**
 * The symbols generated code may reference.
 *
 * The ABI lists are read as the values the modules hold: a table built at the
 * module's top is state a compiled function owns no copy of, so membership is
 * asked of the lists themselves rather than of a table derived from them.
 */

import { RUNTIME_ABI, TEXT_SYMBOLS, WIDE_SYMBOLS } from "./abi.ts";

/* The value helpers the header declares beside the ABI. A lowering uses them
   to cross between the carrier it holds and a tagged value. */
const VALUE_HELPERS: Record<string, true> = {
  blaze_value_number: true,
  blaze_value_number_of: true,
  blaze_value_boolean: true,
  blaze_value_null: true,
  blaze_value_handle: true,
  blaze_value_is: true,
  blaze_value_is_handle: true,
  blaze_value_from_dynamic: true,
  blaze_dynamic_from_value: true,
  blaze_value_c_text: true,
  blaze_value_from_text: true,
  blaze_value_ref: true,
  blaze_value_from_pointer: true,
  blaze_value_from_promise: true,
};
import { HTTP_ABI } from "./http.ts";
import { SQLITE_ABI } from "./sqlite.ts";
import { TRITON_ABI } from "./triton.ts";
import { MODEL_ABI } from "./model.ts";
import { SGLANG_ABI } from "./sglang.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** True when generated code is allowed to reference a symbol. */
export function isRuntimeSymbol(symbol: string): boolean {
  for (const item of RUNTIME_ABI) {
    if (String(fieldOf(item, "symbol")) === symbol) return true;
  }
  if (WIDE_SYMBOLS[symbol] === true) return true;
  if (TEXT_SYMBOLS[symbol] === true) return true;
  if (VALUE_HELPERS[symbol] === true) return true;
  for (const item of HTTP_ABI) {
    if (String(fieldOf(item, "symbol")) === symbol) return true;
  }
  for (const item of SQLITE_ABI) {
    if (String(fieldOf(item, "symbol")) === symbol) return true;
  }
  for (const item of TRITON_ABI) {
    if (String(fieldOf(item, "symbol")) === symbol) return true;
  }
  for (const item of MODEL_ABI) {
    if (String(fieldOf(item, "symbol")) === symbol) return true;
  }
  for (const item of SGLANG_ABI) {
    if (String(fieldOf(item, "symbol")) === symbol) return true;
  }
  return false;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HTTP_ABI,
  httpHeaderSource,
  isHttpSymbol,
} from "../runtime/http.ts";
import { isRuntimeSymbol, RUNTIME_TITLES, RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { RUNTIME_KINDS } from "../core/types.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratch } from "./scratch.ts";

test("the HTTP ABI declares every entry the runtime API promises", async () => {
  const header = httpHeaderSource();
  for (const entry of HTTP_ABI) {
    assert.ok(header.includes(entry.symbol), `${entry.symbol} must be declared in the HTTP header`);
  }
  // facil.io's own types never appear in the public ABI.
  assert.ok(!header.includes("fio_"), "the HTTP header must not expose facil.io types");
  assert.ok(!header.includes("struct fio"), "the HTTP header must not expose facil.io types");
});

test("HTTP symbols are allowed by the runtime symbol boundary", () => {
  for (const entry of HTTP_ABI) {
    assert.ok(isHttpSymbol(entry.symbol), `${entry.symbol} must be an HTTP symbol`);
    assert.ok(isRuntimeSymbol(entry.symbol), `${entry.symbol} must be a generatable symbol`);
  }
  assert.ok(!isHttpSymbol("blaze_rt_allocate"), "a core runtime symbol is not an HTTP symbol");
  assert.ok(!isHttpSymbol("blaze_http_unknown"), "an unknown symbol is not an HTTP symbol");
});

test("the HTTP header keeps the core runtime header intact", () => {
  const header = runtimeHeaderSource();
  assert.ok(header.includes("blaze_rt_allocate"), "the core header still declares the allocator");
  // The core header knows nothing of HTTP: --runtime none does not depend on it.
  assert.ok(!header.includes("blaze_http"), "the core runtime header does not declare HTTP");
});

test("facil is a known runtime kind", () => {
  assert.ok(RUNTIME_KINDS.includes("facil"), "facil is a runtime kind");
  assert.equal(RUNTIME_TITLES["facil"], "the facil.io HTTP server runtime");
});

test("a none build never references facil.io", async () => {
  const directory = await scratch("http-runtime-none-");
  await buildStandaloneRuntime(directory, "debug");
  const cSource = await readFile(join(directory, `${RUNTIME_NAME}.c`), "utf8");
  assert.ok(!cSource.includes("blaze_http"), "the compiler runtime does not reference facil.io");
  assert.ok(!cSource.includes("fio_"), "the compiler runtime does not reference facil.io");
});

/**
 * The HTTP client speaks TLS.
 *
 * A program that asks a server over "https://" gets a runtime that carries
 * OpenSSL, and its `http.request` asks the server over TLS. The runtime is
 * built for the program: the question is read off the source, the same way
 * the SQLite facility is, and the program that asks no server over TLS links
 * neither the library nor the code that uses it.
 *
 * The handshake is the runtime's own code, so the test reads it where it is
 * written: the adapter source the build compiles, guarded by the flag the
 * build sets for a program that speaks TLS.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { facilAdapterSource } from "../runtime/facil.ts";
import { httpRuntimeNeeds, speaksTlsToServer } from "../runtime/http-needs.ts";
import { phaseOf } from "./phase.ts";

test("a source that asks a server over https:// speaks TLS to it", () => {
  assert.equal(speaksTlsToServer(`const body = http.request("https://api.example.com/v1", "GET", "", "");`), true);
  assert.equal(speaksTlsToServer(`const body = http.request("http://127.0.0.1:8080/", "GET", "", "");`), false);
  assert.equal(speaksTlsToServer(`const body = "no url here";`), false);
});

test("the needs of a program that asks over https:// carry TLS", () => {
  const source = `const body = http.request("https://api.example.com/v1", "GET", "", "");\nconsole.log(body);\n`;
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const needs = httpRuntimeNeeds(phase.body, [source]);
  assert.equal(needs.tls, true, "a program that asks over https:// is built with TLS");
  assert.equal(httpRuntimeNeeds(undefined, [`const body = http.request("http://127.0.0.1:8080/", "GET", "", "");`]).tls, false, "a program that asks over http:// is built without TLS");
});

test("the runtime of a program that asks over https:// carries the TLS handshake", () => {
  /* The handshake is the runtime's: the driver writes the call the runtime
     answers, and the runtime is where the session is made. The adapter is
     compiled with TLS for a program that speaks it, so the adapter source is
     where the handshake is written, guarded by the flag the build sets. */
  const adapter = facilAdapterSource();
  assert.match(adapter, /blaze_http_client_tls_handshake/, "the adapter makes the session a request of https:// is made over");
  assert.match(adapter, /#ifdef BLAZE_HTTP_TLS/, "the TLS code is only in a runtime that was built for a program that speaks it");
});

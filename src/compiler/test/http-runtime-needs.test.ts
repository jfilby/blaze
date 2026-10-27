/**
 * What the HTTP runtime of a build is built for, and what the compiler writes
 * out of the strings a program builds.
 *
 * The runtime is built once for a whole program, and what it is built for is
 * read from that program: how many connections its server may hold at once,
 * and whether it speaks TLS. Both are questions the program answers, and both
 * cost the program something when they are answered without looking at it.
 *
 * The strings a program builds are the other half of it: a backend writes a
 * string out by concatenating its pieces one at a time, so the pieces that are
 * written out are joined before the backend sees them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultHttpRuntimeNeeds, httpRuntimeNeeds, DEFAULT_HTTP_MAX_CONNECTIONS } from "../runtime/http-needs.ts";
import { facilAdapterSource, facilIoLibraries } from "../runtime/facil.ts";
import { phaseOf } from "./phase.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { optimizeSemanticProgram } from "../semantics/optimize-ir.ts";
import type { ProgramBody } from "../semantics/module.ts";

/** The body of a one file program, as the compiler reads it. */
function bodyOf(source: string): ProgramBody {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  if (phase.body === undefined) throw new Error("the program declares no body");
  return phase.body;
}

test("a program that says nothing about its server is given the default room", () => {
  const needs = httpRuntimeNeeds(bodyOf('console.log("hello");\n'), ['console.log("hello");\n']);
  assert.equal(needs.maxConnections, DEFAULT_HTTP_MAX_CONNECTIONS, "the default room is what a program that says nothing is given");
  assert.equal(needs.tls, false, "a program that says nothing does not speak TLS");
});

test("a program that states how many connections its server holds is given room for them", () => {
  const source = 'http.serveSettings(18080, 100, 0, 0, 0, 0, 0);\n';
  const needs = httpRuntimeNeeds(bodyOf(source), [source]);
  assert.equal(needs.maxConnections, 164, "the room is the limit the program stated and the room the server needs beside it");
  assert.equal(needs.tls, false, "a server with a limit is not a server that speaks TLS");
});

test("a program that speaks TLS is built with the TLS backend", () => {
  const source = 'http.serveTls(18080, "cert.pem", "key.pem");\n';
  const needs = httpRuntimeNeeds(bodyOf(source), [source]);
  assert.equal(needs.tls, true, "a server that speaks TLS is built with the TLS backend");
});

test("a client request to a URL the source does not spell is built with the TLS backend", () => {
  // The URL a program asks for decides whether its runtime speaks TLS, and
  // the source is where the decision is read from — but not every URL is
  // written in the source. A program that reads its endpoint out of a file of
  // configuration asks for a URL the compiler cannot see, and that URL may
  // well be one over TLS: the runtime is given the backend that can speak
  // either, because the other answer is a request that fails without a word.
  const fromFile = httpRuntimeNeeds(bodyOf('const url = `${fs.readFileSync("config.toml")}`;\nhttp.request(url, "GET", "", "");\n'), [
    'const url = `${fs.readFileSync("config.toml")}`;\nhttp.request(url, "GET", "", "");\n',
  ]);
  assert.equal(fromFile.tls, true, "a URL the compiler cannot read may be one over TLS");

  // A URL the source spells out is still the program's own decision: a
  // literal "http://" is a request over plain text and no TLS backend beside
  // it, whatever else the program reads from a file.
  const spelled = httpRuntimeNeeds(
    bodyOf('const key = `${fs.readFileSync("key.txt")}`;\nhttp.request("http://127.0.0.1:8080/", "POST", key, "x");\n'),
    ['const key = `${fs.readFileSync("key.txt")}`;\nhttp.request("http://127.0.0.1:8080/", "POST", key, "x");\n'],
  );
  assert.equal(spelled.tls, false, "a URL the source spells as http:// is a request over plain text");

  // A template string with nothing interpolated into it is a URL written out
  // in full, whatever punctuation it carries.
  const templated = httpRuntimeNeeds(
    bodyOf('http.request(`http://127.0.0.1:8080/`, "GET", "", "");\n'),
    ['http.request(`http://127.0.0.1:8080/`, "GET", "", "");\n'],
  );
  assert.equal(templated.tls, false, "a template string nothing was interpolated into is a URL the source spells");
});

test("a program that speaks TLS in a function of another file is built with the TLS backend", () => {
  // The source of a file the compiler cannot read the calls of is read as
  // well: a program that asks for TLS anywhere asks for it.
  const needs = httpRuntimeNeeds(undefined, ['http.serveTls(18080, "cert.pem", "key.pem");\n']);
  assert.equal(needs.tls, true, "a TLS server in another file is still a TLS server");
});

test("the scheme a URL begins with decides whether the runtime speaks TLS", () => {
  // The scheme is the part of a URL that decides the transport, and it is the
  // part a program writes out even when the rest of the URL is put together
  // while the program runs. A URL written to begin with "http://" is a request
  // over plain text whatever the host and the port are.
  const source = [
    "const host = \"localhost\";",
    "const port = process.argv[2] || 8080;",
    "const api = `http://${host}:${port}/`;",
    "http.request(api, \"GET\", \"\", \"\");",
    "",
  ].join("\n");
  const needs = httpRuntimeNeeds(bodyOf(source), [source]);
  assert.equal(needs.tls, false, "a URL whose scheme is written out as http:// is a request over plain text");
});

test("a URL that is a name is read from the URL the name was bound to", () => {
  // A program that makes a request usually names the URL first, and the name
  // is bound after the call that asks through it: the program is read twice,
  // once for what it binds and once for what it asks.
  const source = [
    "const answer = http.request(api, \"GET\", \"\", \"\");",
    "const api = \"http://127.0.0.1:8080/\";",
    "console.log(answer);",
    "",
  ].join("\n");
  const needs = httpRuntimeNeeds(bodyOf(source), [source]);
  assert.equal(needs.tls, false, "the name `api` is a URL over plain text");
});

test("a URL whose scheme is not written out is a URL the compiler cannot decide", () => {
  // What is not written out may be anything, and a runtime that cannot decide
  // is given the backend that can speak either: the other answer is a request
  // that fails without a word.
  const notWritten = [
    "const base = `https://${process.argv[2]}/`;",
    "http.request(base, \"GET\", \"\", \"\");",
    "",
  ].join("\n");
  assert.equal(httpRuntimeNeeds(bodyOf(notWritten), [notWritten]).tls, true, "a scheme that is written as https:// speaks TLS");

  const computed = [
    "const base = process.argv[2];",
    "const api = base + \"/\";",
    "http.request(api, \"GET\", \"\", \"\");",
    "",
  ].join("\n");
  assert.equal(httpRuntimeNeeds(bodyOf(computed), [computed]).tls, true, "a URL put together from a name the compiler cannot read may be one over TLS");

  // A name the program may write again is a name that holds the URL the
  // program chose, which is not the one it was declared with.
  const written = [
    "let api = \"http://127.0.0.1:8080/\";",
    "http.request(api, \"GET\", \"\", \"\");",
    "api = \"https://example.com/\";",
    "",
  ].join("\n");
  assert.equal(httpRuntimeNeeds(bodyOf(written), [written]).tls, true, "a name that is written again holds nothing to read");
});

test("a limit the compiler cannot read is given the room facil.io would have given it", () => {
  // The limit is written in a function of another file, so the compiler cannot
  // read how many connections it states. A program that asked for a server
  // with limits meant them, so the server is given the room facil.io gives.
  const needs = httpRuntimeNeeds(undefined, ["export function serve() { http.serveSettings(18080, 100, 0, 0, 0, 0, 0); }\n"]);
  assert.equal(needs.maxConnections, 131072, "a limit that cannot be read is given the room facil.io would have given it");
});

test("a program that speaks no TLS links no TLS library", () => {
  assert.deepEqual(facilIoLibraries(false), [], "a program that speaks no TLS links no TLS library");
  assert.deepEqual(facilIoLibraries(true), ["-lssl", "-lcrypto"], "a program that speaks TLS links OpenSSL");
});

test("the adapter of a runtime without TLS says so rather than serving plain HTTP", () => {
  const adapter = facilAdapterSource();
  assert.match(adapter, /#ifdef BLAZE_HTTP_TLS/, "the TLS server is behind the guard the runtime is built with");
  assert.match(adapter, /built without TLS/, "the runtime that carries no TLS says so");
});

test("a stop wakes the event loop rather than waiting for its tick", () => {
  // The loop waits for an event for a tick before it looks at what it was
  // asked to do, so a stop that waited for the tick costs the program a
  // millisecond of every run. The stop writes to a descriptor the loop watches
  // instead, and the loop looks at the request at once.
  const adapter = facilAdapterSource();
  assert.match(adapter, /socketpair\(AF_UNIX, SOCK_STREAM, 0, blaze_http_wake_fds\)/, "the loop is woken through a pair of descriptors");
  assert.match(adapter, /fio_attach_fd\(blaze_http_wake_fds\[0\], &blaze_http_wake_protocol\)/, "one of the pair is given to the loop to watch");
  assert.match(adapter, /fio_stop\(\);\n\s*blaze_http_wake_loop\(\);/, "the loop is asked to stop and then woken, so the stop is a stop at once");
  assert.match(
    adapter,
    /pthread_join\(blaze_http_server_thread, NULL\);[\s\S]{0,300}?blaze_http_wake_close\(\);/,
    "the pair is closed once the loop it woke has ended",
  );
});

test("the pieces of a string that are written out are joined", () => {
  const source = 'const url = `http://${"localhost"}:${80}/`;\nconsole.log(url);\n';
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const program = resolveProgram(phase.body as ProgramBody, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const folded = optimizeSemanticProgram(program);
  const printed = folded.entry.statements.find((statement) => statement.k === "printText");
  assert.ok(printed !== undefined && printed.k === "printText", "the program prints the url");
  assert.equal(printed.value.k, "text", "the url is a string");
  if (printed.value.k !== "text") return;
  const pieces = printed.value.parts.map((part) => (part.k === "text" ? part.value : "?"));
  assert.deepEqual(pieces, ["http://localhost:", "?", "/"], "the pieces that are written out are one piece");
});

test("a string added to a string is written out when both of them are", () => {
  const source = 'const header = "content-type: " + "application/json";\nconsole.log(header);\n';
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const program = resolveProgram(phase.body as ProgramBody, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const folded = optimizeSemanticProgram(program);
  const printed = folded.entry.statements.find((statement) => statement.k === "printText");
  assert.ok(printed !== undefined && printed.k === "printText", "the program prints the header");
  assert.equal(printed.value.k, "text", "the header is a string rather than an addition");
  if (printed.value.k !== "text") return;
  assert.deepEqual(
    printed.value.parts.map((part) => (part.k === "text" ? part.value : "?")),
    ["content-type: application/json"],
    "the two strings written out are one string written out",
  );
});

test("the header of a request is written out as one literal", () => {
  const source = 'const req = http.request("http://127.0.0.1:8080/", { method: "POST", headers: { "content-type": "application/json" } }, () => {});\n';
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const program = resolveProgram(phase.body as ProgramBody, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const written = generateProgramDriver(program, true);
  assert.match(written, /blaze_http_client_header\(blaze_http_req, "content-type: application\/json"\)/, "the header is one literal rather than a concatenation of two");
});

test("the needs of a program that says nothing are the default needs", () => {
  assert.deepEqual(defaultHttpRuntimeNeeds(), { maxConnections: DEFAULT_HTTP_MAX_CONNECTIONS, tls: false });
});

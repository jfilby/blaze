/**
 * Reading a source as code rather than as text.
 *
 * A build decides which runtime to link from what a program does: it links the
 * HTTP server runtime for a program that names the HTTP facility, and it links
 * OpenSSL for a program that asks a server over TLS. Those decisions used to be
 * made by matching a word anywhere in the file, and comments are the part of a
 * file that is not a program: a benchmark whose comments cite two URLs was
 * linked against a server runtime and OpenSSL it never called, and paid for
 * both at every run.
 *
 * These tests are the two readers that answer the question the word-matching
 * wanted to ask: `withoutComments` keeps the literals and drops the prose, and
 * `codeOnly` drops both.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, withoutComments } from "../util/source.ts";
import { mentionsHttpModule, speaksTlsToServer } from "../runtime/http-needs.ts";
import { usesSqliteSource } from "../runtime/sqlite.ts";

test("a line comment is not code", () => {
  const source = "// a comment that names http.serveTls and https://example.com/\nconst x = 1;\n";
  assert.doesNotMatch(withoutComments(source), /http\.serveTls/);
  assert.doesNotMatch(withoutComments(source), /https:\/\//);
  assert.match(withoutComments(source), /const x = 1;/);
  assert.equal(withoutComments(source).split("\n").length, source.split("\n").length, "the lines below a comment are still the lines they were");
});

test("a block comment is not code, and its newlines stay", () => {
  const source = "/* http.request(\"https://example.com/\")\n   and sqlite.open */\nconst y = 2;\n";
  assert.doesNotMatch(withoutComments(source), /http\.request/);
  assert.doesNotMatch(withoutComments(source), /sqlite\.open/);
  assert.match(withoutComments(source), /const y = 2;/);
  assert.equal(withoutComments(source).split("\n").length, source.split("\n").length);
});

test("a comment written inside a literal is part of the literal", () => {
  // The two slashes are data here, and the URL is the program's own request:
  // blanking them would change the string the program sends.
  const source = 'const url = "http://127.0.0.1:8080/";\n';
  assert.equal(withoutComments(source), source);
  assert.equal(codeOnly(source).length, source.length, "the literal is blanked, not removed");
  assert.doesNotMatch(codeOnly(source), /http/, "the bytes of the string are not code");
  assert.match(codeOnly(source), /^const url = " +";\n$/, "the quotes say a literal was here");
});

test("a literal written inside a comment is part of the comment", () => {
  // The quote is prose here: it must not open a string that swallows the code
  // below it.
  const source = "// a comment with an apostrophe: it's prose\nconst z = 3;\n";
  assert.match(withoutComments(source), /const z = 3;/);
});

test("the code reads the words the prose carries as prose", () => {
  const benchmark = [
    "// Algorithms come from https://paulmillr.com/posts/noble-secp256k1-fast-ecc/",
    "// http://hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html",
    "const x = 1n;",
  ].join("\n");
  assert.equal(mentionsHttpModule(benchmark), false, "a URL in a comment is not a server");
  assert.equal(speaksTlsToServer(benchmark), false, "a URL in a comment is not a request");
  assert.equal(usesSqliteSource("// this program needs no sqlite\nconst x = 1;\n"), false, "a word in a comment is not a call");

  assert.equal(mentionsHttpModule('http.serve(8080, serve);\n'), true, "a call is a call");
  assert.equal(mentionsHttpModule('const body = fetch("http://127.0.0.1:8080/", "GET", "", "");\n'), true, "a fetch is the facility as much as an http. is");
  assert.equal(mentionsHttpModule('console.log("http");\n'), false, "a word in a string is not a call");
  assert.equal(usesSqliteSource('sqlite.open(":memory:");\n'), true, "a call is a call");
});

test("a template literal is walked as the code it interpolates", () => {
  // The text of a template is data, and the `${}` inside it is code: an
  // interpolation whose expression calls HTTP is a program that uses HTTP.
  const source = "const url = `https://example.com/${http.requestPath(request)}`;\n";
  assert.equal(mentionsHttpModule(source), true, "the interpolation is code");
  assert.equal(speaksTlsToServer(source), true, "the literal is a URL the source spells");
  assert.match(withoutComments(source), /http\.requestPath/);
});

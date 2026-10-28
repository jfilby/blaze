/**
 * What the HTTP runtime of a build has to be built for.
 *
 * The runtime is built once for a whole program, and what it is built for is
 * what that program needs of it: how many connections its server may hold at
 * once, and whether it speaks TLS at all. Both are decided by the program
 * itself, and both cost the program something when they are decided without
 * looking at it:
 *
 * - The event loop of the server keeps a table of every connection it may
 *   hold, and the table is as large as the number of connections the runtime
 *   was built for. facil.io sizes that table by the limit the process was
 *   given for open files, which on a machine with a generous limit is 131072
 *   entries: about thirty megabytes, every page of which the program pays for
 *   in a page fault before it answers its first request. A program that
 *   serves ten requests at a time does not need that table, and a program
 *   that says how many connections it wants gets a table of that size.
 *
 * - TLS is OpenSSL, and OpenSSL is a library the program loads before it runs
 *   and carries in its binary. A program that never speaks TLS pays for the
 *   load and neither the load nor the library is worth what it costs.
 *
 * The needs are read from the program the runtime is built for: from the body
 * it runs, and from the sources of the files it is made of. A build that asks
 * for a bigger server or for TLS gets one, and a build that asks for neither
 * gets neither.
 */

import type { ProgramBody, ProgramStatement, ProgramValue } from "../semantics/module.ts";
import { codeOnly, withoutComments } from "../util/source.ts";

/**
 * The most connections the server of a program may hold at once, when the
 * program does not say.
 *
 * Four thousand is far more than a program that does not say needs, and far
 * more than the tests of the runtime open at once. It is what a program is
 * given rather than what it is limited to: a program that says how many
 * connections it wants is given a table of that size, and a program that says
 * nothing is given this much room for a server that may serve as many clients
 * as it is asked to.
 */
export const DEFAULT_HTTP_MAX_CONNECTIONS = 4096;

/**
 * The room a server needs beyond the connections it says it will hold: the
 * listening sockets, the files the program opened beside it, and the sockets
 * the runtime keeps for itself.
 */
const HTTP_CONNECTION_SLACK = 64;

/**
 * The room facil.io gives a server when nothing else is said: the ceiling of
 * its own table of connections. A program that states a limit the compiler
 * cannot read is given this much, because a program that asked for a server
 * with limits is a program that meant them.
 */
const FACIL_IO_MAX_CONNECTIONS = 131072;

/** What the HTTP runtime of a build is built for. */
export interface HttpRuntimeNeeds {
  /**
   * The most connections the program's server may hold at once. The table the
   * event loop keeps is this many entries long, so it is what the program
   * pays for at the start of every run.
   */
  maxConnections: number;
  /**
   * Whether the program speaks TLS. A program that does carries the TLS
   * backend and links OpenSSL; a program that does not carries neither.
   */
  tls: boolean;
}

/** The needs of a program that says nothing about its server. */
export function defaultHttpRuntimeNeeds(): HttpRuntimeNeeds {
  return { maxConnections: DEFAULT_HTTP_MAX_CONNECTIONS, tls: false };
}

/**
 * What a URL says about the transport it is asked over: a URL written to begin
 * with "http://" is a request over plain text, one written to begin with
 * "https://" is a request over TLS, and one whose beginning is not written out
 * says nothing the compiler can read.
 */
type UrlScheme = "plain" | "secure" | "unknown";

/** What the walk of the program found, and what it is still looking for. */
interface Reading {
  /** The needs the walk is filling in. */
  needs: HttpRuntimeNeeds;
  /** How many calls that state a limit the walk found. */
  calls: number;
  /** Whether the walk read the limit a call states. */
  readALimit: boolean;
  /** The room the limit the walk read asks for. */
  room: number;
  /** What the URLs the program bound to names are, by name. A name a program
   *  binds more than once, or writes again, holds nothing to read. */
  schemes: Map<string, UrlScheme>;
  /** Whether this walk is the one that binds names rather than the one that
   *  reads calls. A name may be bound after the function that asks through it
   *  is written, so the program is walked twice: once for what it binds, once
   *  for what it asks. */
  binding: boolean;
}

/**
 * The needs of the program the runtime is built for: the server it starts,
 * and what that server is told to hold.
 *
 * The body of the program is read as the program wrote it, so the limit a
 * server is given is read from the call that gives it. The sources of the
 * files are read as well, because a program may start its server from a
 * function of another file, and a source cannot say how many connections such
 * a server holds — so a program that states a limit the compiler cannot read
 * is given the room facil.io would have given it.
 *
 * The body is walked twice: once for the URLs it binds to names and once for
 * the calls it makes. A name may be bound after the function that asks through
 * it is written, and a request written through a name is a request over the
 * transport the URL the name was bound to is over.
 */
export function httpRuntimeNeeds(body: ProgramBody | undefined, sources: readonly string[]): HttpRuntimeNeeds {
  const reading: Reading = {
    needs: defaultHttpRuntimeNeeds(),
    calls: 0,
    readALimit: false,
    room: 0,
    schemes: new Map(),
    binding: true,
  };
  if (body !== undefined) {
    for (const statement of body.statements) readStatement(statement, reading);
    reading.binding = false;
    for (const statement of body.statements) readStatement(statement, reading);
  }
  /* A server the program states a limit for, and a server the compiler could
     not read the limit of, are two different servers: the first is given the
     room it asked for, and the second is given the room facil.io would have
     given it. A mention the body did not account for is a server of the
     second kind, and so is a call whose limit is not a number the compiler
     can read. */
  let mentions = 0;
  for (const source of sources) {
    if (/\bhttp\.serveTls\b/.test(codeOnly(source))) reading.needs.tls = true;
    /* A program that asks a server over "https://" speaks TLS to it, and the
       runtime it is given has to carry the library that speaks it. The URL is
       the question the program asks, and the source is where the question is
       written down. */
    if (speaksTlsToServer(source)) reading.needs.tls = true;
    mentions += countMentions(source, "http.serveSettings");
  }
  if (reading.readALimit) {
    /* The limit was read, so the table is as long as the limit says. */
    reading.needs.maxConnections = reading.room;
  } else if (reading.calls > 0 || mentions > reading.calls) {
    /* A limit the compiler could not read is a limit the program meant, so the
       server is given the room facil.io would have given it. */
    reading.needs.maxConnections = FACIL_IO_MAX_CONNECTIONS;
  }
  return reading.needs;
}

/**
 * Whether a source asks a server over TLS.
 *
 * The rule is the one the SQLite facility uses: the word in the source is what
 * says so, because the verification has to decide from the source whether to
 * give the program a runtime that speaks TLS, and the rule has to be one the
 * source can be asked about. The word is read from the code: a URL in a
 * comment is prose about a request nobody makes.
 */
export function speaksTlsToServer(source: string): boolean {
  return /\bhttps:\/\//.test(withoutComments(source));
}

/**
 * Whether a program names the HTTP facility.
 *
 * The question is asked of the code, not of the file: a comment that cites a
 * URL is not a program that serves HTTP, and reading one as the other linked
 * the server runtime and OpenSSL into programs that never call either. A
 * string is not code either — a program that prints the word "http" is not a
 * program that uses it.
 *
 * A `fetch` is the facility as much as an `http.` is: the driver writes the
 * same `blaze_http_*` calls for it, and a program that asks one over a URL it
 * wrote in a string was the case the word in the string used to catch by
 * accident.
 */
export function mentionsHttpModule(source: string): boolean {
  const code = codeOnly(source);
  return /\bhttp\b/.test(code) || /\bfetch\s*\(/.test(code);
}

/** How many times a call is written in a source, mentions in a comment and all. */
function countMentions(source: string, callee: string): number {
  const pattern = new RegExp(`\\b${callee.replace(/\./g, "\\.")}\\b`, "g");
  return (codeOnly(source).match(pattern) ?? []).length;
}

/** Reads the HTTP calls a statement makes, and what it holds. */
function readStatement(statement: ProgramStatement, reading: Reading): void {
  switch (statement.kind) {
    case "declare":
      if (reading.binding) bindName(statement.name, statement.value, statement.mutable, reading.schemes);
      readValue(statement.value, reading);
      return;
    case "assign":
      /* A name that is written again holds nothing the compiler can follow. */
      if (reading.binding) reading.schemes.set(statement.name, "unknown");
      readValue(statement.value, reading);
      return;
    case "elementAssign":
      readValue(statement.index, reading);
      readValue(statement.value, reading);
      return;
    case "fieldAssign":
      /* The object is named rather than written out, so there is nothing to
         read in it. */
      return;
    case "fill":
      readValue(statement.value, reading);
      return;
    case "print":
      for (const value of statement.values) readValue(value, reading);
      return;
    case "if":
      readValue(statement.condition, reading);
      for (const inner of statement.then) readStatement(inner, reading);
      for (const inner of statement.otherwise) readStatement(inner, reading);
      return;
    case "while":
    case "doWhile":
      readValue(statement.condition, reading);
      for (const inner of statement.body) readStatement(inner, reading);
      return;
    case "for":
      readValue(statement.from, reading);
      readValue(statement.to, reading);
      if (statement.step !== null) readValue(statement.step, reading);
      for (const inner of statement.body) readStatement(inner, reading);
      return;
    case "forOf":
    case "block":
      for (const inner of statement.body) readStatement(inner, reading);
      return;
    case "invoke":
      readCall(statement.function, statement.args, reading);
      return;
    case "function":
      for (const inner of statement.body) readStatement(inner, reading);
      return;
    case "result":
      readValue(statement.value, reading);
      return;
    case "update":
    case "break":
    case "continue":
      return;
  }
}

/** Reads the HTTP calls a value holds, and what it holds in turn. */
function readValue(value: ProgramValue, reading: Reading): void {
  switch (value.k) {
    case "call":
      readCall(value.function, value.args, reading);
      return;
    case "binary":
      readValue(value.left, reading);
      readValue(value.right, reading);
      return;
    case "unary":
      readValue(value.operand, reading);
      return;
    case "conditional":
      readValue(value.condition, reading);
      readValue(value.then, reading);
      readValue(value.otherwise, reading);
      return;
    case "text":
      for (const part of value.parts) {
        if (part.k === "value") readValue(part.value, reading);
      }
      return;
    case "fixed":
      readValue(value.of, reading);
      return;
    case "buffer":
      for (const item of value.values) readValue(item, reading);
      return;
    case "shared":
    case "sized":
      readValue(value.count, reading);
      return;
    case "view":
      readValue(value.of, reading);
      readValue(value.offset, reading);
      readValue(value.count, reading);
      return;
    case "fill":
      readValue(value.buffer, reading);
      readValue(value.value, reading);
      return;
    case "element":
      readValue(value.index, reading);
      return;
    case "field":
      readValue(value.object, reading);
      return;
    case "object":
      for (const field of value.fields) readValue(field.value, reading);
      return;
    case "arrow":
      for (const inner of value.body) readStatement(inner, reading);
      return;
    case "whole":
    case "number":
    case "boolean":
    case "null":
    case "name":
    case "argv":
    case "length":
      return;
  }
}

/**
 * Reads what a call says about the server of the program: a server that speaks
 * TLS, and a server that is told how many connections to hold.
 *
 * A walk that is binding names reads the values of the arguments and nothing
 * the call says: what a call says is read once every name is bound, because a
 * name may be bound after the function that asks through it is written.
 */
function readCall(callee: string, args: readonly ProgramValue[], reading: Reading): void {
  if (!reading.binding) readWhatTheCallSays(callee, args, reading);
  for (const argument of args) readValue(argument, reading);
}

/** What a call says about the server of the program. */
function readWhatTheCallSays(callee: string, args: readonly ProgramValue[], reading: Reading): void {
  if (callee === "http.serveTls") {
    reading.needs.tls = true;
  } else if (callee === "http.request" || callee === "fetch") {
    /* The URL a client request is made to decides whether the runtime needs
       the TLS backend, and the scheme the URL begins with is what decides it:
       "https://" speaks TLS and "http://" does not. The scheme is the part of
       a URL a program writes out even when the rest of it is put together
       while the program runs — `http://${host}:${port}/` is a request over
       plain text whatever the host and the port are — so the decision is read
       from the beginning of the URL and not from the whole of it. A URL whose
       beginning is not written out is one the compiler cannot decide on, and
       the runtime is given the backend that can speak either. */
    const url = args[0];
    if (url === undefined || schemeOf(url, reading.schemes) !== "plain") reading.needs.tls = true;
  } else if (callee === "http.serveSettings") {
    reading.calls += 1;
    const stated = args[1];
    if (stated !== undefined && (stated.k === "whole" || stated.k === "number")) {
      const wanted = Number(stated.text.replace(/_/g, ""));
      if (Number.isFinite(wanted) && wanted > 0) {
        const room = Math.ceil(wanted) + HTTP_CONNECTION_SLACK;
        /* A program with two servers is given room for the one that holds the
           most, because the table is one table. */
        if (room > reading.room) reading.room = room;
        reading.readALimit = true;
      }
    }
  }
}

/**
 * What the beginning of a URL says about the transport it is asked over.
 *
 * The scheme is the part of a URL that decides the transport, and it is the
 * part a program writes out in full even when the rest of the URL is put
 * together while the program runs. The parts of a text that are written, up to
 * the first that is computed, are the beginning of the URL it is.
 *
 * A name is read from the URL it was bound to, because a program that asks for
 * a URL names it first: `const api = \`http://${host}:${port}/\`` is a request
 * over plain text, and the name `api` is how the request spells it.
 */
function schemeOf(value: ProgramValue, schemes: ReadonlyMap<string, UrlScheme>): UrlScheme {
  if (value.k === "name") return schemes.get(value.name) ?? "unknown";
  if (value.k !== "text") return "unknown";
  let beginning = "";
  for (const part of value.parts) {
    if (part.k !== "text") break;
    beginning += part.value;
  }
  if (beginning.startsWith("https://")) return "secure";
  if (beginning.startsWith("http://")) return "plain";
  return "unknown";
}

/**
 * Remembers what a name holds, so that a request written through the name is
 * read the way the URL it was bound to reads.
 *
 * Only a name that is written once holds something the compiler can follow: a
 * name the program may write again is a name that holds the URL the program
 * chose, which is not the one it was declared with.
 */
function bindName(name: string, value: ProgramValue, mutable: boolean, schemes: Map<string, UrlScheme>): void {
  if (mutable) {
    schemes.set(name, "unknown");
    return;
  }
  const scheme = schemeOf(value, schemes);
  const known = schemes.get(name);
  /* Two declarations of one name are two scopes, and the call may be written
     in either of them. */
  schemes.set(name, known === undefined || known === scheme ? scheme : "unknown");
}

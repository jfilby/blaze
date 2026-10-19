/**
 * The blaze HTTP runtime ABI, backed by facil.io.
 */

export const HTTP_NAME = "blaze_http";

/** One entry point of the HTTP ABI. */
export interface HttpEntry {
  symbol: string;
  returns: string;
  params: readonly (readonly [name: string, type: string])[];
  summary: string;
  ownership: string;
  noreturn?: boolean;
}

function httpEntry(
  symbol: string,
  returns: string,
  params: readonly (readonly [string, string])[],
  summary: string,
  ownership: string,
  extra: { noreturn?: boolean } = {},
): HttpEntry {
  return { symbol, returns, params, summary, ownership, ...extra };
}

/**
 * The HTTP ABI, in call order. Every entry is implemented by the facil.io
 * adapter (`runtime/facil.c`) and declared in the generated `blaze_http.h`.
 * Nothing here names a facil.io type: a program that links only the compiler
 * runtime (`--runtime none`) does not even see these declarations.
 */
export const HTTP_ABI: readonly HttpEntry[] = [
  httpEntry(
    "blaze_http_server_new",
    "void*",
    [["port", "uint16_t"]],
    "Creates an HTTP server listening on a port.",
    "Returns an owned server handle; a null handle means the port could not be bound.",
  ),
  httpEntry(
    "blaze_http_server_run",
    "void",
    [["server", "void*"]],
    "Runs the server event loop until it is stopped.",
    "Never returns while the server runs; the handle is owned by the caller.",
    { noreturn: true },
  ),
  httpEntry(
    "blaze_http_server_stop",
    "void",
    [["server", "void*"]],
    "Stops the server and releases its handle.",
    "The handle is no longer valid after this; a null handle is ignored.",
  ),
  httpEntry(
    "blaze_http_route_register",
    "void",
    [
      ["server", "void*"],
      ["method", "const char*"],
      ["path", "const char*"],
      // A parameter that is a pointer to a function is declared without a name:
      // the header writes the type inside the declarator.
      ["", "void (*)(void*, void*)"],
    ],
    "Registers a route: method and path are handled by the given function.",
    "The handler is invoked with a borrowed request handle and a borrowed response handle.",
  ),
  httpEntry(
    "blaze_http_req_method",
    "const char*",
    [["req", "void*"]],
    "The HTTP method of the request.",
    "Borrowed: valid for the request's lifetime.",
  ),
  httpEntry(
    "blaze_http_req_path",
    "const char*",
    [["req", "void*"]],
    "The request path.",
    "Borrowed: valid for the request's lifetime.",
  ),
  httpEntry(
    "blaze_http_req_header",
    "const char*",
    [
      ["req", "void*"],
      ["name", "const char*"],
    ],
    "A request header value, or an empty string when the header is absent.",
    "Borrowed: valid for the request's lifetime.",
  ),
  httpEntry(
    "blaze_http_req_body",
    "const char*",
    [
      ["req", "void*"],
      ["length", "size_t*"],
    ],
    "The request body bytes, with their length written through length.",
    "Borrowed: valid for the request's lifetime; length excludes no terminator.",
  ),
  httpEntry(
    "blaze_http_resp_status",
    "void",
    [["resp", "void*"], ["status", "uint16_t"]],
    "Sets the response status code.",
    "The response is owned by the caller until completed.",
  ),
  httpEntry(
    "blaze_http_resp_header",
    "void",
    [
      ["resp", "void*"],
      ["name", "const char*"],
      ["value", "const char*"],
    ],
    "Sets a response header.",
    "Copies name and value into the response.",
  ),
  httpEntry(
    "blaze_http_resp_body",
    "void",
    [
      ["resp", "void*"],
      ["bytes", "const unsigned char*"],
      ["length", "size_t"],
    ],
    "Sets the response body bytes.",
    "Copies the bytes into the response.",
  ),
  httpEntry(
    "blaze_http_resp_complete",
    "void",
    [["resp", "void*"]],
    "Sends the response and ends the request.",
    "The response handle is no longer valid after this.",
  ),
  httpEntry(
    "blaze_http_server_new_settings",
    "void*",
    [
      ["port", "uint16_t"],
      ["max_clients", "intptr_t"],
      ["max_body_size", "size_t"],
      ["max_header_size", "size_t"],
      ["timeout", "uint8_t"],
      ["threads", "int"],
      ["workers", "int"],
    ],
    "Creates an HTTP server with resource limits, a connection timeout and a thread/worker count.",
    "Returns an owned server handle; a null handle means the port could not be bound.",
  ),
  httpEntry(
    "blaze_http_server_new_tls",
    "void*",
    [
      ["port", "uint16_t"],
      ["cert", "const char*"],
      ["key", "const char*"],
    ],
    "Creates an HTTPS (TLS) server listening on a port.",
    "Returns an owned server handle; a null handle means the port could not be bound or TLS could not be initialized.",
  ),
];

/** Symbols generated HTTP code may reference. Nothing else resolves at link time. */
export const HTTP_SYMBOLS: Record<string, true> = Object.fromEntries(
  HTTP_ABI.map((item) => [item.symbol, true as const]),
);

/** True when generated code is allowed to reference an HTTP symbol. */
export function isHttpSymbol(symbol: string): boolean {
  return HTTP_SYMBOLS[symbol] === true;
}

const HTTP_HEADER_PREAMBLE = `#ifndef BLAZE_HTTP_H
#define BLAZE_HTTP_H

#include <stddef.h>
#include <stdint.h>

/*
 * The blaze HTTP runtime ABI, backed by facil.io. Every handle is an opaque
 * pointer: facil.io's own types never appear here, and a program that links
 * only the compiler runtime never sees this header.
 */

/* A server handle is owned by its caller until blaze_http_server_stop. */
typedef void blaze_http_server;

/* A request or response handle is borrowed and lives for one request. */
typedef void blaze_http_request;
typedef void blaze_http_response;

/* A route handler is invoked with a borrowed request and a borrowed response. */
typedef void (*blaze_http_handler)(blaze_http_request* request, blaze_http_response* response);
`;

const HTTP_HEADER_EPILOGUE = `
#endif
`;

/** The C header a program that uses the HTTP runtime includes. */
export function httpHeaderSource(): string {
  const declarations = HTTP_ABI.map((item) => {
    const suffix = item.noreturn === true ? " /* never returns */" : "";
    return `${item.returns === "void" ? "void" : item.returns} ${item.symbol}(${
      item.params.length === 0 ? "void" : item.params.map(([name, type]) => `${type} ${name}`).join(", ")
    })${suffix};`;
  }).join("\n");
  return `${HTTP_HEADER_PREAMBLE}\n${declarations}\n\n${HTTP_HEADER_EPILOGUE}`;
}

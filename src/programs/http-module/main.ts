/**
 * The server.
 *
 * The body of a program runs; a module only offers functions. This file is
 * the body: it starts the server and hands it the handler of the module
 * beside it. The handler is compiled by the backend the project names, and
 * the program links it beside itself.
 */
import { handler } from "./handler.ts";

const args = process.argv.slice(2);
const port = Number(args[0]);
const listenPort = port > 0 ? port : 8080;

const server = http.createServer(handler);
server.listen(listenPort, "127.0.0.1", () => {});

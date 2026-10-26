/**
 * Blaze website: a website about Blaze, served by a Blaze program.
 *
 * The program serves a small website (an introduction to Blaze and a chat)
 * over HTTP, answers questions by asking a model on Nebius Token Factory,
 * and saves every question and answer to a SQLite database.
 *
 * The program is compiled by Blaze to a native binary with the facil.io
 * HTTP runtime vendored into it and the SQLite library linked beside it.
 *
 * Usage:
 *   blaze-website [port]
 *
 * The port defaults to 8080. The endpoint the chat asks and the model it
 * asks there are read from config.toml in the working directory, and the key
 * it asks with comes from the NEBIUS_API_KEY environment variable.
 */

const fs = require("fs");

const args = process.argv.slice(2);
const portArg = args[0];
const listenPort = portArg > 0 ? portArg : 8080;

const web = "web";

const db = sqlite.open("chats.db");
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT, answer TEXT)");

/* The configuration, read once when the program starts. A file that is not
   there is read as the empty text, and every value a configuration without
   the line answers the empty text too: the chat answers with the error that
   says so rather than a call the endpoint cannot be made with. */
let configText = "";
try {
  configText = `${fs.readFileSync("config.toml", "utf8")}`;
} catch {
  configText = "";
}

/**
 * The value of one `key = "value"` line of the configuration, with the
 * quotes and the whitespace the line leaves behind gone. A key the
 * configuration does not name answers the empty text.
 */
function configValue(text: string, key: string): string {
  const at = text.indexOf(`${key} = "`);
  if (at < 0) return "";
  const rest = text.slice(at + key.length + 4, text.length);
  const end = rest.indexOf("\"");
  if (end < 0) return "";
  return rest.slice(0, end).trim();
}

/** The endpoint the chat asks, and the model it asks there. */
const ENDPOINT = configValue(configText, "endpoint");
const MODEL = configValue(configText, "model");
/** The key the chat asks with, from the environment: it is never written
 *  into the source, the configuration or anything the browser is sent. */
const apiKey = process.env.NEBIUS_API_KEY;

/**
 * The text as JSON says it: every quote, backslash and end of a line escaped,
 * so a question with any of them in it is still one JSON string when the
 * model reads it, and so is every answer the saved chats are written out as.
 */
function jsonEscape(value: string): string {
  var out = "";
  var rest = value;
  while (rest.length > 0) {
    const backslash = rest.indexOf("\\");
    const quote = rest.indexOf("\"");
    const newline = rest.indexOf("\n");
    const enter = rest.indexOf("\r");
    const tab = rest.indexOf("\t");
    var stop = -1;
    if (backslash >= 0) stop = backslash;
    if (quote >= 0 && (stop < 0 || quote < stop)) stop = quote;
    if (newline >= 0 && (stop < 0 || newline < stop)) stop = newline;
    if (enter >= 0 && (stop < 0 || enter < stop)) stop = enter;
    if (tab >= 0 && (stop < 0 || tab < stop)) stop = tab;
    if (stop < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, stop);
    const character = rest.slice(stop, stop + 1);
    if (character === "\\") out += "\\\\";
    else if (character === "\"") out += "\\\"";
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    rest = rest.slice(stop + 1, rest.length);
  }
  return out;
}

/** What the model answered last, as the JSON it sent. */
var modelAnswer = "";

/**
 * Asks the model the question. The answer is written into the name the
 * program holds it in, because a function hands back a number or a
 * reference, and the JSON an answer is, is a string.
 */
function askModel(question: string): void {
  if (apiKey === "") {
    modelAnswer = `{"error":{"type":"config","message":"NEBIUS_API_KEY is not set"}}`;
  } else {
    const body = `{"model":"${MODEL}","messages":[{"role":"user","content":"${jsonEscape(question)}"}],"temperature":0.7}`;
    const headers = `Authorization: Bearer ${apiKey}\r\nContent-Type: application/json\r\n`;
    modelAnswer = `${http.request(ENDPOINT, "POST", headers, body)}`;
  }
}

function saveChat(question, answer): void {
  const insert = sqlite.prepare(db, "INSERT INTO chats (question, answer) VALUES (?, ?)");
  sqlite.bindText(insert, 1, question);
  sqlite.bindText(insert, 2, answer);
  sqlite.step(insert);
  sqlite.finalize(insert);
}

var chatsJson = "";

function buildChats(): void {
  const read = sqlite.prepare(db, "SELECT id, question, answer FROM chats ORDER BY id DESC");
  let json = "[";
  let first = 1;
  while (sqlite.step(read) > 0) {
    if (first === 0) {
      json += ",";
    }
    first = 0;
    json += `{"id":${sqlite.columnNumber(read, 0)},"question":"${jsonEscape(`${sqlite.columnText(read, 1)}`)}","answer":"${jsonEscape(`${sqlite.columnText(read, 2)}`)}"}`;
  }
  sqlite.finalize(read);
  json += "]";
  chatsJson = json;
}

const indexHtml = `${fs.readFileSync(`${web}/index.html`, "utf8")}`;
const appJs = `${fs.readFileSync(`${web}/app.js`, "utf8")}`;
const styleCss = `${fs.readFileSync(`${web}/style.css`, "utf8")}`;

const server = http.createServer((req: any, res: any) => {
  const path = req.path;
  const method = req.method;

  if (path === "/" && method === "GET") {
    res.writeHead(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(indexHtml);
  } else if (path === "/app.js" && method === "GET") {
    res.writeHead(200);
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(appJs);
  } else if (path === "/style.css" && method === "GET") {
    res.writeHead(200);
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(styleCss);
  } else if (path === "/api/chat" && method === "POST") {
    /* The question arrives as the body of the request, plain text: a JSON
       body would have to be read field by field, and a field of a parsed
       JSON object is read as the number it is, which a question is not. */
    const question = req.text();
    askModel(question);
    saveChat(question, modelAnswer);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(modelAnswer);
  } else if (path === "/api/chats" && method === "GET") {
    buildChats();
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(chatsJson);
  } else {
    res.writeHead(404);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found\n");
  }
});

console.log(`blaze website is serving on http://127.0.0.1:${listenPort}/`);

server.listen(listenPort, "127.0.0.1", () => {});

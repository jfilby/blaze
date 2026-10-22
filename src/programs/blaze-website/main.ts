/**
 * Blaze website: a website about Blaze, served by a Blaze program.
 *
 * The program serves a small website (an introduction to Blaze and a chat)
 * over HTTP, answers questions by asking a model on Nebius Token Factory,
 * and saves every question and answer to a SQLite database.
 *
 * The program is compiled by Blaze to a native binary with the facil.io
 * HTTP runtime and the SQLite library beside it.
 *
 * Usage:
 *   blaze-website [port]
 *
 * The port defaults to 8080. The Nebius Token Factory API key is read from a
 * file named NEBIUS_API_KEY in the working directory.
 */

const fs = require("fs");

const args = process.argv.slice(2);
const portArg = args[0];
const listenPort = portArg > 0 ? portArg : 8080;
const keyFile = "NEBIUS_API_KEY";
/** The endpoint the chat asks, and the model it asks: the Token Factory
 *  endpoint and its cheapest text-to-text model. */
const ENDPOINT = "https://api.tokenfactory.nebius.com/v1/chat/completions";

const web = "web";

const db = sqlite.open("chats.db");
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT, answer TEXT)");

let apiKey = "";
try {
  apiKey = `${fs.readFileSync(keyFile, "utf8")}`;
} catch {
  apiKey = "";
}

const MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

function askModel(question): any {
  const body = `{"model":"${MODEL}","messages":[{"role":"user","content":"${question}"}],"temperature":0.7}`;
  const headers = "Authorization: Bearer " + apiKey + "\r\nContent-Type: application/json\r\n";
  const response = http.request(ENDPOINT, "POST", headers, body);
  return response;
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
    json += `{"id":${sqlite.columnNumber(read, 0)},"question":"${sqlite.columnText(read, 1)}","answer":"${sqlite.columnText(read, 2)}"}`;
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
    const answer = askModel(question);
    saveChat(question, answer);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(answer);
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

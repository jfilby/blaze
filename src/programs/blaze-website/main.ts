/**
 * Blaze website: a website about Blaze, served by a Blaze program.
 *
 * The program serves a home page and a chat over HTTP, answers questions by
 * asking a model on Nebius Token Factory, and saves every question and answer
 * to a SQLite database. A saved chat can be resumed: the model is given the
 * conversation so far, and the new question continues the thread it belongs
 * to.
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
/* Every question and answer is a row of messages, and the thread a row
   belongs to is the id of the question that began it: a chat that is
   resumed is the thread its rows share. The chats table holds the chats of
   the schema before threads, and they are copied into it once, each as its
   own thread. The meta table holds the marker that says the copy ran. */
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT, answer TEXT)");
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread INTEGER, question TEXT, answer TEXT)");
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
/* Every thread belongs to a person, named by the cookie the browser holds.
   The people table is the source of the ids: an insert into it makes the
   next id, and an id is never handed to a second person. The column the
   schema before people had no room for is added beside it, so a database
   that was made before the cookie was keeps its rows. */
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT)");
/* The column the schema before people had no room for is added beside it, so
   a database that was made before the cookie was keeps its rows — and those
   rows belonged to nobody the cookie can name, so no person owns them. */
sqlite.exec(db, "ALTER TABLE messages ADD COLUMN person TEXT");
sqlite.exec(db, "UPDATE messages SET person = '' WHERE person IS NULL");

const marker = sqlite.prepare(db, "SELECT value FROM meta WHERE key = 'migrated'");
var migrated = 0;
if (sqlite.step(marker) > 0) migrated = 1;
sqlite.finalize(marker);
if (migrated === 0) {
  sqlite.exec(db, "INSERT INTO messages (thread, question, answer) SELECT id, question, answer FROM chats");
  sqlite.exec(db, "INSERT INTO meta (key, value) VALUES ('migrated', '1')");
}

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

/** The cookie that names the person a browser is: its name, and how long a
 *  browser keeps it, in seconds — a year, which a visitor who comes back
 *  within is still the person they were. */
const PERSON_COOKIE = "blaze_chat";
const PERSON_COOKIE_MAX_AGE = 31536000;

/**
 * The value of one cookie of a `Cookie` header: `name=value; other=value`
 * is read for the one cookie whose name is asked for. A cookie the header
 * does not carry answers the empty text.
 */
function cookieValue(header: string, name: string): string {
  const wanted = `${name}=`;
  var rest = header;
  while (rest.length > 0) {
    const at = rest.indexOf(wanted);
    if (at < 0) return "";
    /* The name has to begin the cookie it is read from: a value that holds
       the name is not the name. A cookie begins the header or follows the
       semicolon and the space that separate it from the one before. */
    if (at === 0 || rest.slice(at - 1, at) === " " || rest.slice(at - 1, at) === ";") {
      const value = rest.slice(at + wanted.length, rest.length);
      const end = value.indexOf(";");
      return (end < 0 ? value : value.slice(0, end)).trim();
    }
    rest = rest.slice(at + wanted.length, rest.length);
  }
  return "";
}

/** The person a request was sent by: the id the cookie names. A request
 *  without the cookie, or with one that names nobody, is sent by nobody. */
function personOf(header: string): number {
  const named = cookieValue(header, PERSON_COOKIE);
  if (named === "") return 0;
  const wanted = Number(named);
  return wanted > 0 ? wanted : 0;
}

/** The id of a person nobody has been yet: an insert into the people table
 *  makes one, and AUTOINCREMENT never hands an id out twice. */
function newPerson(): number {
  sqlite.exec(db, "INSERT INTO people DEFAULT VALUES");
  const last = sqlite.prepare(db, "SELECT MAX(id) FROM people");
  var made = 0;
  if (sqlite.step(last) > 0) made = sqlite.columnNumber(last, 0);
  sqlite.finalize(last);
  return made;
}

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

/** How the model is told to answer: the chat is about Blaze, and the model
 *  is told what Blaze is — the stages it runs, the frontends it reads and
 *  the backends it lowers to — so an answer it gives is an answer about the
 *  compiler this website is for, and not a guess from a name alone. The
 *  prompt travels with every question, and the sentence at its end is the
 *  reason an answer is a few sentences and not an essay. */
const PROMPT =
  "You answer questions about Blaze, an AI compiler for the Blaze research project. " +
  "Blaze compiles traditional source through a rule-based pipeline: source, then an intermediate representation (IR), then verified or revised IR, then target low-level code, then verified or revised target code, then the binary. " +
  "Large language models verify the IR and the low-level targets and propose fixes, but they never implement fixes themselves: a rule-based compiler evaluates each proposal and applies it only when it is valid. " +
  "LLM use at compile time is optional: a build works with no model, no API key and no network, because the pipeline is rule-based throughout. " +
  "The frontends are TypeScript, Python and Triton kernels. " +
  "The backends are native machine code (an x86_64 code generator, with a C lowering beside it), C, and WebAssembly. " +
  "The runtimes: the facil.io HTTP server runtime is vendored into the binary, SQLite is linked beside programs that store data, and a built program can call a model over HTTPS at run time. " +
  "You can get Blaze from https://github.com/jfilby/blaze-nebius. " +
  "Blaze was developed for the Nebius hackathon on DevPost: https://nebiusglobalaihackathon.devpost.com. " +
  "Every answer is short: at most three sentences, plain text with no markdown.";

/** How many turns of a resumed thread the model is given: the last ten of
 *  them, which is enough to know what the words in front of it point at, and
 *  few enough to keep the request small. */
const HISTORY_TURNS = 10;

/**
 * The content of the model's reply, read out of the JSON it sent: the first
 * choice, the message of it, and the content of that. A reply that is not a
 * model reply — the JSON of an error — answers the empty text, and the
 * question it belongs to travels to the model with no answer behind it.
 */
function answerTextOf(raw: string): string {
  if (raw.indexOf("{") !== 0) return raw;
  const parsed = JSON.parse(raw);
  const choices = JSON.get(parsed, "choices");
  if (Number(choices) != 0) {
    const first = choices[0];
    if (Number(first) != 0) {
      const message = JSON.get(first, "message");
      if (Number(message) != 0) {
        return `${JSON.get(message, "content")}`;
      }
    }
  }
  return "";
}

/**
 * Asks the model the question. The answer is written into the name the
 * program holds it in, because a function hands back a number or a
 * reference, and the JSON an answer is, is a string.
 */
function askModel(question: string, thread: number): void {
  if (apiKey === "") {
    modelAnswer = `{"error":{"type":"config","message":"NEBIUS_API_KEY is not set"}}`;
  } else {
    /* The conversation the model is given: the system prompt, then the turns
       of the thread the question continues, oldest first, then the question
       itself. A question that begins a thread travels alone. */
    var messages = `{"role":"system","content":"${jsonEscape(PROMPT)}"}`;
    if (thread > 0) {
      const counter = sqlite.prepare(db, "SELECT COUNT(*) FROM messages WHERE thread = ?");
      sqlite.bindNumber(counter, 1, thread);
      var count = 0;
      if (sqlite.step(counter) > 0) count = sqlite.columnNumber(counter, 0);
      sqlite.finalize(counter);
      var offset = 0;
      if (count > HISTORY_TURNS) offset = count - HISTORY_TURNS;
      const read = sqlite.prepare(db, `SELECT question, answer FROM messages WHERE thread = ? ORDER BY id ASC LIMIT ${HISTORY_TURNS} OFFSET ${offset}`);
      sqlite.bindNumber(read, 1, thread);
      while (sqlite.step(read) > 0) {
        const earlier = `${sqlite.columnText(read, 0)}`;
        const answered = answerTextOf(`${sqlite.columnText(read, 1)}`);
        messages += `,{"role":"user","content":"${jsonEscape(earlier)}"}`;
        if (answered !== "") messages += `,{"role":"assistant","content":"${jsonEscape(answered)}"}`;
      }
      sqlite.finalize(read);
    }
    messages += `,{"role":"user","content":"${jsonEscape(question)}"}`;
    const body = `{"model":"${MODEL}","messages":[${messages}],"temperature":0.7}`;
    const headers = `Authorization: Bearer ${apiKey}\r\nContent-Type: application/json\r\n`;
    modelAnswer = `${http.request(ENDPOINT, "POST", headers, body)}`;
  }
}

/** The thread the question that was saved last belongs to. A question that
 *  began a thread of its own is saved under the id of the row it made, and
 *  the chat route answers with that id: the browser asks the next question
 *  of the same thread, so the conversation the panel holds — a run of
 *  questions, or a resumed chat — is one session, and the saved chats show
 *  it as the one entry it is. */
var savedThread = 0;

/** The thread the question that was saved last belongs to, held as the text
 *  of the number it is: a name a handler captures is a copy unless it is an
 *  array or a string, and the thread the browser is to continue has to be
 *  seen by the handler that answers. A question that began a thread of its
 *  own is saved under the id of the row it made, and the chat route answers
 *  with that id: the browser asks the next question of the same thread, so
 *  the conversation the panel holds — a run of questions, or a resumed chat
 *  — is one session, and the saved chats show it as the one entry it is. */
var savedThreadText = "0";

/** The thread the last question was saved under, as a number. */
function savedThread(): number {
  return Number(savedThreadText);
}

function saveChat(question: string, answer: string, thread: number, person: number): void {
  const insert = sqlite.prepare(db, "INSERT INTO messages (thread, question, answer, person) VALUES (?, ?, ?, ?)");
  sqlite.bindNumber(insert, 1, thread);
  sqlite.bindText(insert, 2, question);
  sqlite.bindText(insert, 3, answer);
  sqlite.bindText(insert, 4, `${person}`);
  sqlite.step(insert);
  sqlite.finalize(insert);
  /* A question that began a thread is its own thread root: the row was
     written with no thread, and its id is the thread it starts. */
  if (thread === 0) {
    const last = sqlite.prepare(db, "SELECT MAX(id) FROM messages");
    var made = 0;
    if (sqlite.step(last) > 0) made = sqlite.columnNumber(last, 0);
    sqlite.finalize(last);
    if (made > 0) {
      const fix = sqlite.prepare(db, "UPDATE messages SET thread = ? WHERE id = ?");
      sqlite.bindNumber(fix, 1, made);
      sqlite.bindNumber(fix, 2, made);
      sqlite.step(fix);
      sqlite.finalize(fix);
      savedThreadText = `${made}`;
    }
  } else {
    savedThreadText = `${thread}`;
  }
}

var chatsJson = "";

function buildChats(person: number): void {
  /* One entry per saved chat — a thread — and the entry is the last message
     the thread exchanged, of the threads the person the request was sent by
     owns: the newest row of each of their threads, the newest ten of them. */
  const read = sqlite.prepare(db, "SELECT id, thread, question, answer FROM messages WHERE person = ? AND id IN (SELECT MAX(id) FROM messages WHERE person = ? GROUP BY thread) ORDER BY id DESC LIMIT 10");
  sqlite.bindText(read, 1, `${person}`);
  sqlite.bindText(read, 2, `${person}`);
  let json = "[";
  let first = 1;
  while (sqlite.step(read) > 0) {
    if (first === 0) {
      json += ",";
    }
    first = 0;
    json += `{"id":${sqlite.columnNumber(read, 0)},"thread":${sqlite.columnNumber(read, 1)},"question":"${jsonEscape(`${sqlite.columnText(read, 2)}`)}","answer":"${jsonEscape(`${sqlite.columnText(read, 3)}`)}"}`;
  }
  sqlite.finalize(read);
  json += "]";
  chatsJson = json;
}

/** What a clear answered, as the JSON the browser reads. */
var clearJson = "{}";

/**
 * Clears the chat that is open: every message of the thread it belongs to
 * is deleted from the database — but only the thread the person the request
 * was sent by owns, so a thread another person holds is never touched. A
 * chat that was never saved — one that began a thread of its own and has
 * not been asked yet, or one the browser began anew — has no thread to
 * delete, and the call leaves the database alone; the browser clears the
 * panel it was showing either way.
 */
function clearChat(id: number, person: number): void {
  clearJson = `{"cleared":${id > 0 ? id : 0}}`;
  if (id > 0) {
    const del = sqlite.prepare(db, "DELETE FROM messages WHERE thread = ? AND person = ?");
    sqlite.bindNumber(del, 1, id);
    sqlite.bindText(del, 2, `${person}`);
    sqlite.step(del);
    sqlite.finalize(del);
  }
}

/** What a delete answered, as the JSON the browser reads. */
var deleteJson = "{}";

/**
 * Deletes one saved chat: the thread the row belongs to is gone from the
 * database, the last message it exchanged included — but only when the
 * person the request was sent by owns it. The id the browser sends is the
 * row it saw in the list of saved chats, and the thread behind that row is
 * what a saved chat is.
 */
function deleteChat(id: number, person: number): void {
  deleteJson = `{"deleted":${id > 0 ? id : 0}}`;
  if (id > 0) {
    const finder = sqlite.prepare(db, "SELECT thread FROM messages WHERE id = ? AND person = ?");
    sqlite.bindNumber(finder, 1, id);
    sqlite.bindText(finder, 2, `${person}`);
    var thread = 0;
    if (sqlite.step(finder) > 0) thread = sqlite.columnNumber(finder, 0);
    sqlite.finalize(finder);
    if (thread > 0) {
      const del = sqlite.prepare(db, "DELETE FROM messages WHERE thread = ? AND person = ?");
      sqlite.bindNumber(del, 1, thread);
      sqlite.bindText(del, 2, `${person}`);
      sqlite.step(del);
      sqlite.finalize(del);
    }
  }
}

/** The transcript of a resumed chat, as JSON: the thread it belongs to, and
 *  its questions and answers oldest first. */
var resumeJson = "";

function buildResume(id: number, person: number): void {
  resumeJson = "[]";
  const finder = sqlite.prepare(db, "SELECT thread FROM messages WHERE id = ? AND person = ?");
  sqlite.bindNumber(finder, 1, id);
  sqlite.bindText(finder, 2, `${person}`);
  var thread = 0;
  if (sqlite.step(finder) > 0) thread = sqlite.columnNumber(finder, 0);
  sqlite.finalize(finder);
  if (thread > 0) {
    const read = sqlite.prepare(db, "SELECT id, question, answer FROM messages WHERE thread = ? AND person = ? ORDER BY id ASC");
    sqlite.bindNumber(read, 1, thread);
    sqlite.bindText(read, 2, `${person}`);
    var json = `{"thread":${thread},"messages":[`;
    var first = 1;
    while (sqlite.step(read) > 0) {
      if (first === 0) {
        json += ",";
      }
      first = 0;
      json += `{"id":${sqlite.columnNumber(read, 0)},"question":"${jsonEscape(`${sqlite.columnText(read, 1)}`)}","answer":"${jsonEscape(`${sqlite.columnText(read, 2)}`)}"}`;
    }
    sqlite.finalize(read);
    json += "]}";
    resumeJson = json;
  }
}

const indexHtml = `${fs.readFileSync(`${web}/index.html`, "utf8")}`;
const chatHtml = `${fs.readFileSync(`${web}/chat.html`, "utf8")}`;
const appJs = `${fs.readFileSync(`${web}/app.js`, "utf8")}`;
const styleCss = `${fs.readFileSync(`${web}/style.css`, "utf8")}`;

/**
 * One answer the server sends: the status, the kind of the body, the body
 * itself, and the cookie a browser is to keep, when it was sent by nobody
 * the cookie could name. The cookie is written on every answer, so the
 * first page a browser opens makes it a person and every request after
 * carries the id back.
 */
function respond(res: any, status: number, kind: string, body: string, setCookie: string): void {
  res.writeHead(status);
  res.setHeader("Content-Type", kind);
  if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
  res.end(body);
}

const server = http.createServer((req: any, res: any) => {
  const path = req.path;
  const method = req.method;

  const cookieText = `${req.header("Cookie")}`;
  var person = personOf(cookieText);
  var setCookie = "";
  if (person === 0) {
    person = newPerson();
    setCookie = `${PERSON_COOKIE}=${person}; Path=/; Max-Age=${PERSON_COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  if (path === "/" && method === "GET") {
    respond(res, 200, "text/html; charset=utf-8", indexHtml, setCookie);
  } else if (path === "/chat" && method === "GET") {
    respond(res, 200, "text/html; charset=utf-8", chatHtml, setCookie);
  } else if (path === "/app.js" && method === "GET") {
    respond(res, 200, "text/javascript; charset=utf-8", appJs, setCookie);
  } else if (path === "/style.css" && method === "GET") {
    respond(res, 200, "text/css; charset=utf-8", styleCss, setCookie);
  } else if (path === "/api/chat" && method === "POST") {
    /* The question arrives as the body of the request, plain text: a JSON
       body would have to be read field by field, and a field of a parsed
       JSON object is read as the number it is, which a question is not. A
       question that continues a thread says so in front of itself, as
       "T<thread>\\n", and the rest of the body is the question. */
    const body = req.text();
    var thread = 0;
    var question = `${body}`;
    const at = body.indexOf("\n");
    if (at > 0 && body.slice(0, 1) === "T") {
      const wanted = Number(body.slice(1, at));
      if (wanted > 0) {
        thread = wanted;
        /* The rest of the body, from behind the thread marker to the end:
           the one-index slice runs there, because the length of a dynamic
           value is not one a program reads. */
        question = body.slice(at + 1);
      }
    }
    askModel(question, thread);
    saveChat(question, modelAnswer, thread, person);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
    /* The thread the question was saved under travels with the answer, so
       the browser asks the next question of the same session: the
       conversation the panel holds is one chat, and the saved chats show it
       as the one entry it is. An answer that is nothing at all — a request
       the model never answered — travels as a null reply, which the browser
       names rather than parses. */
    if (modelAnswer === "") {
      res.end(`{"thread":${savedThread()},"reply":null}`);
    } else {
      res.end(`{"thread":${savedThread()},"reply":${modelAnswer}}`);
    }
  } else if (path.indexOf("/api/resume/") === 0 && method === "GET") {
    buildResume(Number(path.slice(12, path.length)), person);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
    res.end(resumeJson);
  } else if (path === "/api/clear" && method === "POST") {
    /* The chat that is open names the thread it continues, as "T<thread>":
       the same marker a question that continues a thread travels with. A
       body without one is a chat that was never saved, and there is nothing
       in the database to delete. */
    const body = req.text();
    var thread = 0;
    const at = body.indexOf("\n");
    if (at > 0 && body.slice(0, 1) === "T") {
      const wanted = Number(body.slice(1, at));
      if (wanted > 0) thread = wanted;
    }
    clearChat(thread, person);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
    res.end(clearJson);
  } else if (path.indexOf("/api/chats/") === 0 && method === "DELETE") {
    /* The id of the saved chat is the tail of the path, from behind the
       eleven characters of "/api/chats/". */
    deleteChat(Number(path.slice(11, path.length)), person);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
    res.end(deleteJson);
  } else if (path === "/api/chats" && method === "GET") {
    buildChats(person);
    res.writeHead(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
    res.end(chatsJson);
  } else {
    res.writeHead(404);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (setCookie !== "") res.setHeader("Set-Cookie", setCookie);
    res.end("not found\n");
  }
});

console.log(`blaze website is serving on http://127.0.0.1:${listenPort}/`);

server.listen(listenPort, "127.0.0.1", () => {});

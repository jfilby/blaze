/**
 * The frontend of the Blaze website: a chat that asks questions about Blaze.
 *
 * The chat sends each question to the Blaze program, which asks a model on
 * Nebius Token Factory and saves the question and answer to SQLite. The
 * page also loads the saved chats and shows them below the form.
 *
 * The Vercel AI SDK is what the chat is built on when the visitor gives the
 * page an API key of their own: then the question streams straight from the
 * browser to Nebius Token Factory, token by token. It is imported where it
 * is used, so a page that is never given a key never asks a content
 * delivery network for the library at all — the chat through the Blaze
 * program is the one that works without one.
 */

/** The model the chat asks: the cheapest text model on Nebius Token Factory. */
const MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

/** The endpoint the model answers from, as the SDK is pointed at it. */
const BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/** The key the visitor gave the page, kept in the page's own storage. */
const KEY_STORAGE = "blaze-nebius-key";

/** The elements the page writes into. */
const form = document.getElementById("form");
const input = document.getElementById("input");
const messages = document.getElementById("messages");
const chats = document.getElementById("chats");
const error = document.getElementById("error");
const keyInput = document.getElementById("key-input");
const keyForget = document.getElementById("key-forget");

/** Whether a request is in flight. */
let busy = false;

/** Shows an error message under the form. */
function showError(message) {
  error.textContent = message;
  error.style.display = "block";
}

/** Hides the error message. */
function hideError() {
  error.style.display = "none";
}

/** Appends one message to the chat transcript. */
function appendMessage(who, text) {
  const div = document.createElement("div");
  div.className = "message " + who;
  const whoDiv = document.createElement("div");
  whoDiv.className = "who";
  whoDiv.textContent = who === "user" ? "You" : "Blaze";
  const textDiv = document.createElement("div");
  textDiv.textContent = text;
  div.appendChild(whoDiv);
  div.appendChild(textDiv);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

/** The answer of a saved chat: the content of the model's reply, when the
 *  chat carries the model's own JSON, and the raw text otherwise. */
function answerOf(chat) {
  const saved = typeof chat.answer === "string" && chat.answer.startsWith("{") ? JSON.parse(chat.answer) : chat.answer;
  return saved?.choices?.[0]?.message?.content || String(chat.answer);
}

/** Asks the Blaze program a question and shows the answer. */
async function askThroughBlaze(question) {
  /* The question is sent as the body of the request, plain text: the program
     reads it with req.text() and asks the model with it, and saves the chat. */
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: question,
  });
  if (!response.ok) throw new Error("the server answered " + response.status);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}

/** Asks the model a question from the browser, streaming the answer token by
 *  token with the Vercel AI SDK. A chat asked this way is not saved: the
 *  question and the answer would have to travel to the program in a form the
 *  program could tell apart, and the text of a program is not cut. */
async function askFromBrowser(question, apiKey) {
  const { createOpenAI } = await import("https://esm.sh/@ai-sdk/openai");
  const { streamText } = await import("https://esm.sh/ai");
  const model = createOpenAI({ baseURL: BASE_URL, apiKey })(MODEL);
  const stream = streamText({ model, prompt: question });
  const div = document.createElement("div");
  div.className = "message assistant";
  const whoDiv = document.createElement("div");
  whoDiv.className = "who";
  whoDiv.textContent = "Blaze";
  const textDiv = document.createElement("div");
  div.appendChild(whoDiv);
  div.appendChild(textDiv);
  messages.appendChild(div);
  let answer = "";
  for await (const chunk of stream.textStream) {
    answer += chunk;
    textDiv.textContent = answer;
    messages.scrollTop = messages.scrollHeight;
  }
  if (answer === "") {
    div.remove();
    throw new Error("the model answered nothing");
  }
  return answer;
}

/** Asks a question: from the browser when a key was given, and through the
 *  Blaze program when it was not. */
async function ask(question) {
  hideError();
  appendMessage("user", question);
  input.value = "";
  input.disabled = true;
  form.querySelector("button").disabled = true;
  busy = true;

  try {
    const apiKey = keyInput.value.trim();
    if (apiKey === "") {
      appendMessage("assistant", await askThroughBlaze(question));
    } else {
      localStorage.setItem(KEY_STORAGE, apiKey);
      appendMessage("assistant", await askFromBrowser(question, apiKey));
    }
    await loadChats();
  } catch (failure) {
    showError(failure instanceof Error ? failure.message : String(failure));
    appendMessage("assistant", "Sorry, I could not answer that question.");
  } finally {
    input.disabled = false;
    form.querySelector("button").disabled = false;
    input.focus();
    busy = false;
  }
}

/** Loads the saved chats from the Blaze program and shows them. */
async function loadChats() {
  try {
    const response = await fetch("/api/chats");
    if (!response.ok) throw new Error("could not load chats");
    const list = await response.json();
    chats.innerHTML = "";
    for (const chat of list) {
      const div = document.createElement("div");
      div.className = "chat";
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = "Q: " + chat.question;
      const a = document.createElement("div");
      a.className = "a";
      a.textContent = "A: " + answerOf(chat);
      div.appendChild(q);
      div.appendChild(a);
      chats.appendChild(div);
    }
    if (list.length === 0) {
      chats.textContent = "No saved chats yet.";
    }
  } catch {
    chats.textContent = "Could not load saved chats.";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const question = input.value.trim();
  if (question === "") return;
  ask(question);
});

input.addEventListener("keypress", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (busy) return;
    const question = input.value.trim();
    if (question === "") return;
    ask(question);
  }
});

/** The key the page was given before, if there was one. */
keyInput.value = localStorage.getItem(KEY_STORAGE) ?? "";
if (keyInput.value !== "") keyForget.style.display = "inline";

/** Forgets the key the page was given. */
keyForget.addEventListener("click", () => {
  localStorage.removeItem(KEY_STORAGE);
  keyInput.value = "";
  keyForget.style.display = "none";
});

/** A key that is typed in is kept, and the way to forget it appears. */
keyInput.addEventListener("input", () => {
  keyForget.style.display = keyInput.value.trim() === "" ? "none" : "inline";
});

loadChats();

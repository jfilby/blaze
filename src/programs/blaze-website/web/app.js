/**
 * The frontend of the Blaze website: a chat that asks questions about Blaze.
 *
 * The chat sends each question to the Blaze program, which asks a model on
 * Nebius Token Factory and saves the question and answer to SQLite. The Nebius
 * API key lives only on the server (in a file beside it); nothing about it
 * ever reaches the browser, and the page never calls Nebius directly: every
 * answer comes back through the Blaze program.
 *
 * The page also loads the saved chats and shows them below the form.
 */

/** The elements the page writes into. */
const form = document.getElementById("form");
const input = document.getElementById("input");
const messages = document.getElementById("messages");
const chats = document.getElementById("chats");
const error = document.getElementById("error");

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

/** Appends one message to the chat transcript and returns the element. */
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
  return div;
}

/** Shows a "Blaze is typing" indicator and returns it, so it can be removed. */
function showTyping() {
  const div = document.createElement("div");
  div.className = "typing";
  div.appendChild(document.createTextNode("Blaze is typing"));
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement("div");
    dot.className = "dot";
    div.appendChild(dot);
  }
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

/** Removes a typing indicator the page is showing. */
function hideTyping(typing) {
  if (typing !== null && typing.isConnected) typing.remove();
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
  /* The answer is the model's JSON, or the JSON of an error the program
     could not answer with. Either way it is JSON, but a body that arrived
     empty or arrived as anything else is read as the text it is and named,
     rather than thrown past the person who asked. */
  const raw = await response.text();
  try {
    const data = JSON.parse(raw);
    if (data && data.error) return "The model could not be asked: " + (data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content || JSON.stringify(data);
  } catch {
    if (raw.trim() === "") throw new Error("the model answered nothing");
    return raw;
  }
}

/** Asks a question: always through the Blaze program, which holds the key. */
async function ask(question) {
  hideError();
  appendMessage("user", question);
  input.value = "";
  input.disabled = true;
  form.querySelector("button").disabled = true;
  busy = true;

  try {
    const typing = showTyping();
    const answer = await askThroughBlaze(question);
    hideTyping(typing);
    appendMessage("assistant", answer);
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
      chats.className = "chats empty";
    }
  } catch {
    chats.textContent = "Could not load saved chats.";
    chats.className = "chats empty";
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

loadChats();

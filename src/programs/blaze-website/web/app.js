/**
 * The frontend of the Blaze website's chat page.
 *
 * The chat sends each question to the Blaze program, which asks a model on
 * Nebius Token Factory and saves the question and answer to SQLite. The
 * Nebius API key lives only in the environment the program runs in; nothing
 * about it ever reaches the browser, and the page never calls Nebius
 * directly: every answer comes back through the Blaze program.
 *
 * The page also loads the saved chats and shows them below the form, and a
 * saved chat can be resumed: its transcript is loaded into the panel and the
 * questions asked afterwards continue the thread it belongs to, so the model
 * answers with the conversation so far behind it.
 */

/** The elements the page writes into. */
const form = document.getElementById("form");
const input = document.getElementById("input");
const messages = document.getElementById("messages");
const chats = document.getElementById("chats");
const error = document.getElementById("error");
const newChat = document.getElementById("newChat");
const clearChat = document.getElementById("clearChat");

/** Whether a request is in flight. */
let busy = false;

/** The thread the next question continues: 0 for a chat that begins anew,
 *  and the id of the thread a saved chat started when it was resumed. */
let currentThread = 0;

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
  whoDiv.textContent = who === "user" ? "You" : "Blaze assistant";
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
 *  chat carries the model's own JSON, and the raw text otherwise. The JSON
 *  of an error the program could not answer with is named as the error it
 *  is, rather than shown as the JSON it is. */
function answerOf(chat) {
  const saved = typeof chat.answer === "string" && chat.answer.startsWith("{") ? JSON.parse(chat.answer) : chat.answer;
  if (saved && saved.error) {
    return "The model could not be asked: " + (saved.error.message || JSON.stringify(saved.error));
  }
  return saved?.choices?.[0]?.message?.content || String(chat.answer);
}

/** Asks the Blaze program a question and shows the answer. The answer
 *  travels with the thread the question was saved under, and the questions
 *  asked next continue that thread: the conversation the panel holds is one
 *  session, and the saved chats show it as the one entry it is. */
async function askThroughBlaze(question, thread) {
  /* The question is sent as the body of the request, plain text: the program
     reads it with req.text() and asks the model with it, and saves the chat.
     A question that continues a thread says so in front of itself, as
     "T<thread>\n", which the program reads as the thread to continue. */
  const body = thread > 0 ? `T${thread}\n${question}` : question;
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  if (!response.ok) throw new Error("the server answered " + response.status);
  /* The answer travels as the thread it was saved under and the model's JSON
     beside it. A thread the program names is the session the panel holds, so
     the next question continues it without the page asking twice. */
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("the server answered with something that was not JSON");
  }
  if (data && data.thread > 0) currentThread = data.thread;
  const reply = data ? data.reply : null;
  if (reply === null || reply === undefined) throw new Error("the model answered nothing");
  if (reply.error) return "The model could not be asked: " + (reply.error.message || JSON.stringify(reply.error));
  return reply?.choices?.[0]?.message?.content || JSON.stringify(reply);
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
    const answer = await askThroughBlaze(question, currentThread);
    hideTyping(typing);
    appendMessage("assistant", answer);
    /* The question was saved under a thread, so the panel holds a session of
       its own: a new chat and a clear are both there to be asked for. The
       list of saved chats is left as it is — it is loaded when the page
       opens and after a chat is cleared or deleted, not after every message
       the session is asked. */
    newChat.hidden = false;
    clearChat.hidden = false;
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

/** Resumes a saved chat: its transcript is loaded into the panel, and the
 *  questions asked afterwards continue the thread it belongs to. */
async function resumeChat(id) {
  hideError();
  try {
    const response = await fetch("/api/resume/" + id);
    if (!response.ok) throw new Error("the server answered " + response.status);
    const data = await response.json();
    if (!data || !data.messages) throw new Error("that chat is not there any more");
    currentThread = data.thread;
    messages.innerHTML = "";
    for (const message of data.messages) {
      appendMessage("user", message.question);
      appendMessage("assistant", answerOf(message));
    }
    newChat.hidden = false;
    clearChat.hidden = false;
    input.focus();
  } catch (failure) {
    showError(failure instanceof Error ? failure.message : String(failure));
  }
}

/** Starts a chat anew: the next question begins a thread of its own. */
function startNewChat() {
  hideError();
  currentThread = 0;
  messages.innerHTML = "";
  newChat.hidden = true;
  clearChat.hidden = true;
  input.focus();
}

/** Clears the chat that is open: the thread it continues is deleted from
 *  the database, and the panel it was showing is emptied. A chat that was
 *  never saved has nothing to delete, and the panel is emptied all the same. */
async function clearOpenChat() {
  hideError();
  const thread = currentThread;
  startNewChat();
  if (thread > 0) {
    try {
      const response = await fetch("/api/clear", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: `T${thread}\n`,
      });
      if (!response.ok) throw new Error("the server answered " + response.status);
      await loadChats();
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : String(failure));
    }
  }
}

/** Deletes one saved chat: the thread it is saved as is gone from the
 *  database, and the list of saved chats is loaded again. A chat that is
 *  deleted while it is the one the panel is showing is cleared from the
 *  panel as well, so the panel never shows a chat that is gone. */
async function deleteSavedChat(id) {
  hideError();
  try {
    const response = await fetch("/api/chats/" + id, { method: "DELETE" });
    if (!response.ok) throw new Error("the server answered " + response.status);
    if (currentThread > 0 && currentThread === id) startNewChat();
    await loadChats();
  } catch (failure) {
    showError(failure instanceof Error ? failure.message : String(failure));
  }
}

/** A saved message as the list of chats shows it: the first 200 characters,
 *  and an ellipsis behind the ones a longer message keeps past there. */
function preview(text) {
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
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
      q.textContent = "Q: " + preview(chat.question);
      const a = document.createElement("div");
      a.className = "a";
      a.textContent = "A: " + preview(answerOf(chat));
      div.appendChild(q);
      div.appendChild(a);
      const actions = document.createElement("div");
      actions.className = "chat-actions-row";
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "resume";
      resume.textContent = "Resume";
      resume.addEventListener("click", () => {
        resumeChat(chat.thread);
      });
      actions.appendChild(resume);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "delete";
      del.textContent = "Delete";
      del.setAttribute("aria-label", "Delete saved chat " + chat.thread);
      del.addEventListener("click", () => {
        deleteSavedChat(chat.thread);
      });
      actions.appendChild(del);
      div.appendChild(actions);
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

newChat.addEventListener("click", () => {
  startNewChat();
});

clearChat.addEventListener("click", () => {
  clearOpenChat();
});

loadChats();

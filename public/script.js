const socket = io();

const loginPage = document.getElementById("loginPage");
const updatesPage = document.getElementById("updatesPage");
const chatPage = document.getElementById("chatPage");

const usernameInput = document.getElementById("usernameInput");
const joinChatBtn = document.getElementById("joinChatBtn");
const updatesBtn = document.getElementById("updatesBtn");
const backToMenuBtn = document.getElementById("backToMenuBtn");

const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");

let username = "";

/* === PAGE NAVIGATION === */
joinChatBtn.addEventListener("click", () => {
  username = usernameInput.value.trim();
  if (!username || username.length < 2) {
    return alert("Username must be at least 2 characters long");
  }

  loginPage.classList.add("hidden");
  chatPage.classList.remove("hidden");
});

updatesBtn.addEventListener("click", () => {
  loginPage.classList.add("hidden");
  updatesPage.classList.remove("hidden");
});

backToMenuBtn.addEventListener("click", () => {
  updatesPage.classList.add("hidden");
  loginPage.classList.remove("hidden");
});

/* === CHAT === */
function sendMessage() {
  const msg = chatInput.value.trim();
  if (msg !== "") {
    socket.emit("chat message", { username, message: msg });
    chatInput.value = "";
  }
}

chatInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

socket.on("chat message", (data) => {
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("username");
  nameSpan.textContent = data.username + ":";

  const textSpan = document.createElement("span");
  textSpan.classList.add("message-text");
  textSpan.textContent = " " + data.message;

  msgDiv.appendChild(nameSpan);
  msgDiv.appendChild(textSpan);

  chatBox.appendChild(msgDiv);
  chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "smooth" });
});

/* === Favicon Fix === */
const favicon = document.getElementById("favicon");
function setFavicon(href) {
  if (favicon) favicon.href = href;
}



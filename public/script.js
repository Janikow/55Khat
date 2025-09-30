const socket = io();
let username = "";

// --- Favicon notification setup ---
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";       // normal icon
const alertFavicon = "favicon-alert.ico";   // alert icon
let hasNewMessage = false;

function setFavicon(src) {
  favicon.href = src;
}
// -----------------------------------

function setUsername() {
  const input = document.getElementById("usernameInput");
  username = input.value.trim();
  if (!username) return alert("Please enter a username");

  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");

  socket.emit("join", username);
}

function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message) return;

  socket.emit("chat message", { user: username, text: message });
  input.value = "";
}

socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  let displayName = data.user;
  // Special rule for TemMoose
  if (data.user === "TemMoose") {
    displayName = "Tem";
    msgDiv.classList.add("tem");
  }

  if (data.user === username) {
    msgDiv.classList.add("user");
  }

  msgDiv.textContent = `${displayName}: ${data.text}`;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;

  // --- New message favicon alert ---
  if (document.hidden) {
    setFavicon(alertFavicon);
    hasNewMessage = true;
  }
});

socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");

  usersList.innerHTML = "";
  users.forEach(u => {
    const div = document.createElement("div");
    div.textContent = u === "TemMoose" ? "Tem" : u;
    if (u === "TemMoose") div.classList.add("tem");
    usersList.appendChild(div);
  });

  userCount.textContent = users.length;
});

// --- Reset favicon when returning to tab ---
window.addEventListener("focus", () => {
  if (hasNewMessage) {
    setFavicon(defaultFavicon);
    hasNewMessage = false;
  }
});


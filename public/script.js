const socket = io();
let username = "";

// --- Favicon notification setup ---
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";          // normal icon
const alertFavicon = "favicon-alert.ico";      // alert icon
let hasNewMessage = false;

function setFavicon(src) {
  if (favicon) favicon.href = src;
}
// -----------------------------------

function setUsername() {
  const input = document.getElementById("usernameInput");
  username = input.value.trim();

  // Username validation
  if (!username || username.length < 2) {
    return alert("Username must be at least 2 characters long");
  }

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

// Enter key to send messages
document.getElementById("chatInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  let displayName = data.user;

  // Special rule for TemMoose
  if (data.user === "TemMoose") {
    displayName = "Tem";
    msgDiv.classList.add("tem"); // custom CSS class
  }

  if (data.user === username) {
    msgDiv.classList.add("user");
  }

  // Create structured message with username + text
  const usernameSpan = document.createElement("span");
  usernameSpan.classList.add("username");
  usernameSpan.textContent = displayName;

  const messageSpan = document.createElement("span");
  messageSpan.classList.add("message-text");
  messageSpan.textContent = data.text;

  msgDiv.appendChild(usernameSpan);
  msgDiv.appendChild(messageSpan);

  chatBox.appendChild(msgDiv);

  // Smooth scroll
  chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "smooth" });

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

// --- Updates page navigation ---
function openUpdates() {
  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("updatesPage").classList.remove("hidden");
}

function closeUpdates() {
  document.getElementById("updatesPage").classList.add("hidden");
  document.getElementById("loginPage").classList.remove("hidden");
}




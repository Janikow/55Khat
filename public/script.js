const socket = io();
let username = "";

// --- Favicon notification setup ---
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";
const alertFavicon = "favicon-alert.ico";
let hasNewMessage = false;

function setFavicon(src) {
  favicon.href = src;
}

// --- Set username ---
function setUsername() {
  const input = document.getElementById("usernameInput");
  username = input.value.trim();
  if (username.length < 2 || username.length > 18)
    return alert("Username must be 2–18 characters.");

  socket.emit("join", username);
}

// --- If username is taken ---
socket.on("username taken", () => {
  alert("That username is already in use. Please choose a different one.");
  document.getElementById("usernameInput").value = "";
});

// --- If join is successful ---
socket.on("join success", () => {
  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");
});

// --- Incoming message handler ---
socket.on("message", (data) => {
  const chat = document.getElementById("chat");
  const msg = document.createElement("div");
  msg.innerHTML = `<strong>${data.name}:</strong> ${data.text}`;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;

  if (document.hidden && !hasNewMessage) {
    hasNewMessage = true;
    setFavicon(alertFavicon);
  }
});

// --- Reset favicon when back on page ---
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    hasNewMessage = false;
    setFavicon(defaultFavicon);
  }
});

// --- User list update ---
socket.on("user list", (list) => {
  const userList = document.getElementById("userList");
  userList.innerHTML = list.map((n) => `<li>${n}</li>`).join("");
});

// --- Banned user handler ---
socket.on("banned", () => {
  alert("You have been banned by the server.");
  window.location.href = "/banned.html";
});

// --- Send message ---
function sendMessage() {
  const input = document.getElementById("messageInput");
  const msg = input.value.trim();
  if (msg) {
    socket.emit("message", msg);
    input.value = "";
  }
}


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
  if (username.length < 2 || username.length > 18) return alert("Username must be 2–18 characters.");

  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");

  socket.emit("join", username);
}

// --- Send message ---
function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || message.length > 600) return;

  socket.emit("chat message", { user: username, text: message });
  input.value = "";
}

// --- Enter key sends ---
document.getElementById("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// --- Send image ---
function sendImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.type === "image/gif" && file.size > 5 * 1024 * 1024) return alert("GIF > 5MB not allowed.");

  const reader = new FileReader();
  reader.onload = () => socket.emit("chat message", { user: username, image: reader.result });
  reader.readAsDataURL(file);
  event.target.value = "";
}

// --- Receive messages ---
socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  let displayName = data.user;

  if (data.user === "TemMoose") displayName = "Tem", msgDiv.classList.add("tem");
  if (data.user === "TristanGlizzy") displayName = "Fishtan", msgDiv.classList.add("glitchy");
  if (data.user === "BowdownP3asents") displayName = "Wobbler", msgDiv.classList.add("wobbler");
  if (data.user === "JonathanZachery") displayName = "Hydreil", msgDiv.classList.add("hydreil");
  if (data.user === "JairoIsraelTeliz") displayName = "ISRAEL", msgDiv.classList.add("israel");
  if (data.user === "EzekielGreen333") displayName = "Zeke", msgDiv.classList.add("zeke");
  if (data.user === username) msgDiv.classList.add("user");

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("username");
  nameSpan.textContent = displayName;
  msgDiv.appendChild(nameSpan);

  if (data.text) {
    const textSpan = document.createElement("span");
    textSpan.classList.add("message-text");
    textSpan.textContent = data.text;
    msgDiv.appendChild(textSpan);
  }

  if (data.image) {
    const img = document.createElement("img");
    img.src = data.image;
    img.style.maxWidth = "200px";
    img.style.borderRadius = "8px";
    img.style.marginTop = "6px";
    msgDiv.appendChild(img);
  }

  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;

  if (document.hidden) { setFavicon(alertFavicon); hasNewMessage = true; }
});

// --- User list update ---
socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");

  usersList.innerHTML = "";
  users.forEach(u => {
    let displayName = u;
    if (u === "TemMoose") displayName = "Tem";
    if (u === "TristanGlizzy") displayName = "Fishtan";
    if (u === "BowdownP3asents") displayName = "Wobbler";
    if (u === "JonathanZachery") displayName = "Hydreil";
    if (u === "JairoIsraelTeliz") displayName = "ISRAEL";
    if (u === "EzekielGreen333") displayName = "Zeke";

    const div = document.createElement("div");
    div.textContent = displayName;
    usersList.appendChild(div);
  });

  userCount.textContent = `${users.length} Online`;
});

// --- Reset favicon when focused ---
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && hasNewMessage) {
    setFavicon(defaultFavicon);
    hasNewMessage = false;
  }
});

// --- Ban screen handling ---
socket.on("banned", (info) => {
  alert(`You have been banned by "${info.by}"`);
  window.location.href = '/banned.html';
});




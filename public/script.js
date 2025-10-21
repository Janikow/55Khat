const socket = io();
let username = "";
let serverPort = "";

// --- Favicon setup ---
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";
const alertFavicon = "favicon-alert.ico";
let hasNewMessage = false;

function setFavicon(src) {
  favicon.href = src;
}

// --- Set username and port ---
function setUsername() {
  const nameInput = document.getElementById("usernameInput");
  const portInput = document.getElementById("serverPortInput");

  username = nameInput.value.trim();
  serverPort = portInput.value.trim();

  if (username.length < 2 || username.length > 18)
    return alert("Username must be 2–18 characters.");
  if (!serverPort)
    return alert("Please enter a server port.");

  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");

  socket.emit("join", { name: username, port: serverPort });
}

// --- Send message ---
function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || message.length > 600) return;

  if (message.startsWith("/")) {
    const match = message.match(/^\/(\w+)\s+(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/);
    if (!match) return;

    const command = match[1].toLowerCase();
    const targetName = match[2] || match[3];
    const rest = match[4]?.trim() || "";

    if (command === "w" || command === "whisper") {
      socket.emit("whisper", { from: username, to: targetName, text: rest });
      input.value = "";
      return;
    }

    if (command === "ban") {
      socket.emit("ban", { from: username, target: targetName });
      input.value = "";
      return;
    }

    if (command === "unban") {
      socket.emit("unban", { from: username, target: targetName });
      input.value = "";
      return;
    }
  }

  socket.emit("chat message", { user: username, text: message });
  input.value = "";
}

// --- Enter to send ---
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
  if (file.type === "image/gif" && file.size > 5 * 1024 * 1024)
    return alert("GIF > 5MB not allowed.");

  const reader = new FileReader();
  reader.onload = () =>
    socket.emit("chat message", { user: username, image: reader.result });
  reader.readAsDataURL(file);
  event.target.value = "";
}

// --- Receive chat messages ---
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
  if (data.user === "-173A") displayName = "Tem sold me fent", msgDiv.classList.add("tem-sold-me-fent");
  if (data.user === "G4t$by1130!") displayName = "sai", msgDiv.classList.add("sai");

  if (data.user === username) msgDiv.classList.add("user");
  if (data.whisper) msgDiv.classList.add("whisper");

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("username");
  nameSpan.textContent = displayName;
  msgDiv.appendChild(nameSpan);

  if (data.text) {
    const textSpan = document.createElement("span");
    textSpan.classList.add("message-text");
    if (data.whisper) {
      const direction =
        data.to && data.user === username
          ? ` → ${data.to}`
          : data.to
          ? ` (to ${data.to})`
          : "";
      textSpan.textContent = `(whisper)${direction} ${data.text}`;
    } else {
      textSpan.textContent = data.text;
    }
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

  if (document.hidden) {
    setFavicon(alertFavicon);
    hasNewMessage = true;
  }
});

// --- User list ---
socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");

  usersList.innerHTML = "";
  users.forEach((u) => {
    let displayName = u;
    if (u === "TemMoose") displayName = "Tem";
    if (u === "TristanGlizzy") displayName = "Fishtan";
    if (u === "BowdownP3asents") displayName = "Wobbler";
    if (u === "JonathanZachery") displayName = "Hydreil";
    if (u === "JairoIsraelTeliz") displayName = "ISRAEL";
    if (u === "EzekielGreen333") displayName = "Zeke";
    if (u === "-173A") displayName = "Tem sold me fent";
    if (u === "G4t$by1130!") displayName = "sai";

    const div = document.createElement("div");
    div.textContent = displayName;
    div.classList.add("user-entry");
    if (u === username) div.classList.add("self");
    usersList.appendChild(div);
  });

  userCount.textContent = users.length;
});

// --- Ban handling ---
socket.on("banned", (data) => {
  alert(`You were banned by ${data.by || "the server"}.`);
  window.location.reload();
});

// --- Reset favicon when tab active ---
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && hasNewMessage) {
    setFavicon(defaultFavicon);
    hasNewMessage = false;
  }
});

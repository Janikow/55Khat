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

  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");

  socket.emit("join", username);
}

// --- Send message ---
function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || message.length > 600) return;

  // --- COMMAND HANDLING ---
  if (message.startsWith("/")) {
    // Match commands with optional quotes
    const match = message.match(/^\/(\w+)\s+(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/);
    if (!match) return;

    const command = match[1].toLowerCase();
    const targetName = match[2] || match[3]; // name (quoted or unquoted)
    const rest = match[4]?.trim() || "";

    // --- Whisper Command ---
    if (command === "w" || command === "whisper") {
      socket.emit("whisper", {
        from: username,
        to: targetName,
        text: rest,
      });
      input.value = "";
      return;
    }

    // --- Ban Command ---
    if (command === "ban") {
      socket.emit("ban", {
        from: username,
        target: targetName,
      });
      input.value = "";
      return;
    }

    // --- Unban Command ---
    if (command === "unban") {
      socket.emit("unban", {
        from: username,
        target: targetName,
      });
      input.value = "";
      return;
    }
  }

  // --- Normal Chat Message ---
  socket.emit("chat message", { user: username, text: message });
  input.value = "";
}

// --- Chat input Enter-to-send ---
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

    if (u === "TemMoose") div.classList.add("tem");
    if (u === "TristanGlizzy") div.classList.add("glitchy");
    if (u === "BowdownP3asents") div.classList.add("wobbler");
    if (u === "JonathanZachery") div.classList.add("hydreil");
    if (u === "JairoIsraelTeliz") div.classList.add("israel");
    if (u === "EzekielGreen333") div.classList.add("zeke");
    if (u === "-173A") div.classList.add("tem-sold-me-fent");
    if (u === "G4t$by1130!") div.classList.add("sai");

    usersList.appendChild(div);
  });

  userCount.textContent = users.length;
});

// --- Ban handler ---
socket.on("banned", (data) => {
  const chatPage = document.getElementById("chatPage");
  chatPage.innerHTML = "";

  const banDiv = document.createElement("div");
  banDiv.style.display = "flex";
  banDiv.style.flexDirection = "column";
  banDiv.style.justifyContent = "center";
  banDiv.style.alignItems = "center";
  banDiv.style.height = "100vh";
  banDiv.style.background = "linear-gradient(135deg, #2c2c2c, #1a1a1a)";
  banDiv.style.color = "#ff3c3c";
  banDiv.style.fontFamily = "Arial, sans-serif";
  banDiv.style.textAlign = "center";
  banDiv.style.padding = "20px";

  const title = document.createElement("h1");
  title.textContent = "You have been banned!";
  title.style.fontSize = "3rem";
  title.style.marginBottom = "20px";
  title.style.textShadow = "0 0 10px red";

  const reason = document.createElement("p");
  reason.textContent = data.by ? `Banned by: ${data.by}` : "Banned by server";
  reason.style.fontSize = "1.5rem";
  reason.style.marginBottom = "30px";

  const info = document.createElement("p");
  info.textContent = "You cannot access the chat anymore.";
  info.style.fontSize = "1rem";

  banDiv.appendChild(title);
  banDiv.appendChild(reason);
  banDiv.appendChild(info);

  chatPage.appendChild(banDiv);
});

// --- Reset favicon ---
window.addEventListener("focus", () => {
  if (hasNewMessage) {
    setFavicon(defaultFavicon);
    hasNewMessage = false;
  }
});

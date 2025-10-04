const socket = io();
let username = "";
let roomPin = "";

// --- Favicon notification setup ---
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";
const alertFavicon = "favicon-alert.ico";
let hasNewMessage = false;

function setFavicon(src) {
  favicon.href = src;
}

// --- Validate Username ---
function setUsername() {
  const input = document.getElementById("usernameInput");
  username = input.value.trim();
  if (username.length < 2 || username.length > 18) {
    alert("Username must be 2–18 characters.");
    return false;
  }
  return true;
}

// --- Join Public Room ---
document.getElementById("joinPublicBtn").addEventListener("click", () => {
  if (!setUsername()) return;
  roomPin = "3501";
  socket.emit("joinRoom", { username, roomPin });
});

// --- Join Custom Pin Room ---
document.getElementById("joinPinBtn").addEventListener("click", () => {
  if (!setUsername()) return;
  const pinInput = document.getElementById("pinInput").value.trim();
  if (!/^\d{4}$/.test(pinInput)) {
    alert("Please enter a valid 4-digit pin.");
    return;
  }
  roomPin = pinInput;
  socket.emit("joinRoom", { username, roomPin });
});

// --- When successfully joined ---
socket.on("joinedRoom", ({ username, roomPin }) => {
  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");
  document.getElementById("chatBox").innerHTML += `<div class="system-message">Joined room ${roomPin}</div>`;
});

// --- Send message ---
function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || message.length > 600) return;
  if (!roomPin) return alert("You are not in a room.");

  socket.emit("chatMessage", { user: username, text: message, roomPin });
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
  if (file.type === "image/gif" && file.size > 5 * 1024 * 1024) {
    return alert("GIF > 5MB not allowed.");
  }

  const reader = new FileReader();
  reader.onload = () => socket.emit("chatMessage", { user: username, image: reader.result, roomPin });
  reader.readAsDataURL(file);
  event.target.value = "";
}

// --- Receive chat messages ---
socket.on("chatMessage", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  let displayName = data.user;

  // Custom display names & styles
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

  if (document.hidden) {
    setFavicon(alertFavicon);
    hasNewMessage = true;
  }
});

// --- Update User List ---
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

    const div = document.createElement("div");
    div.textContent = displayName;

    if (u === "TemMoose") div.classList.add("tem");
    if (u === "TristanGlizzy") div.classList.add("glitchy");
    if (u === "BowdownP3asents") div.classList.add("wobbler");
    if (u === "JonathanZachery") div.classList.add("hydreil");
    if (u === "JairoIsraelTeliz") div.classList.add("israel");
    if (u === "EzekielGreen333") div.classList.add("zeke");

    usersList.appendChild(div);
  });

  userCount.textContent = users.length;
});

// --- System message support ---
socket.on("systemMessage", (msg) => {
  const chatBox = document.getElementById("chatBox");
  const div = document.createElement("div");
  div.classList.add("system-message");
  div.textContent = msg;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
});

// --- Banned handler ---
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

// --- Reset favicon when returning to tab ---
window.addEventListener("focus", () => {
  if (hasNewMessage) {
    setFavicon(defaultFavicon);
    hasNewMessage = false;
  }
});


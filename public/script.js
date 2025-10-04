const socket = io();
let username = "";

// Favicon notification setup
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";
const alertFavicon = "favicon-alert.ico";
let hasNewMessage = false;

function setFavicon(src) {
  favicon.href = src;
}

// Set username
function setUsername() {
  const input = document.getElementById("usernameInput");
  username = input.value.trim();

  if (username.length < 2 || username.length > 18) {
    return alert("Username must be 2–18 characters.");
  }

  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");
  socket.emit("join", username);
}

// Send message
function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();

  if (!message || message.length > 600) return;

  socket.emit("chat message", {
    user: username,
    text: message
  });

  input.value = "";
}

// Chat input Enter-to-send
document.getElementById("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send image
function sendImage(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.type === "image/gif" && file.size > 5 * 1024 * 1024) {
    return alert("GIF > 5MB not allowed.");
  }

  const reader = new FileReader();
  reader.onload = () => {
    socket.emit("chat message", {
      user: username,
      image: reader.result
    });
  };
  reader.readAsDataURL(file);
  event.target.value = ""; // reset input
}

// --- Handle incoming messages ---
socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  // Apply custom styles per user
  let displayName = data.user;
  const nameMap = {
    "TemMoose": { alias: "Tem", class: "tem" },
    "TristanGlizzy": { alias: "Fishtan", class: "glitchy" },
    "BowdownP3asents": { alias: "Wobbler", class: "wobbler" },
    "JonathanZachery": { alias: "Hydreil", class: "hydreil" },
    "JairoIsraelTeliz": { alias: "ISRAEL", class: "israel" },
    "EzekielGreen333": { alias: "Zeke", class: "zeke" }
  };

  if (nameMap[data.user]) {
    displayName = nameMap[data.user].alias;
    msgDiv.classList.add(nameMap[data.user].class);
  }

  if (data.user === username) {
    msgDiv.classList.add("user");
  }

  // Username label
  const nameSpan = document.createElement("span");
  nameSpan.classList.add("username");
  nameSpan.textContent = displayName;
  msgDiv.appendChild(nameSpan);

  // Text message
  if (data.text) {
    const textSpan = document.createElement("span");
    textSpan.classList.add("message-text");
    textSpan.textContent = data.text;
    msgDiv.appendChild(textSpan);
  }

  // Image
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

// --- Update user list ---
socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");
  usersList.innerHTML = "";

  users.forEach(u => {
    const div = document.createElement("div");
    let displayName = u;

    if (nameMap[u]) {
      displayName = nameMap[u].alias;
      div.classList.add(nameMap[u].class);
    }

    div.textContent = displayName;
    usersList.appendChild(div);
  });

  userCount.textContent = users.length;
});

// --- Banned handler ---
socket.on("banned", (data) => {
  const chatPage = document.getElementById("chatPage");
  chatPage.innerHTML = ""; // wipe chat

  const banDiv = document.createElement("div");
  banDiv.style.cssText = `
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    background: linear-gradient(135deg, #2c2c2c, #1a1a1a);
    color: #ff3c3c;
    font-family: Arial, sans-serif;
    text-align: center;
    padding: 20px;
  `;

  const title = document.createElement("h1");
  title.textContent = "You have been banned!";
  title.style.cssText = `
    font-size: 3rem;
    margin-bottom: 20px;
    text-shadow: 0 0 10px red;
  `;

  const reason = document.createElement("p");
  reason.textContent = data.by ? `Banned by: ${data.by}` : "Banned by server";
  reason.style.cssText = `
    font-size: 1.5rem;
    margin-bottom: 30px;
  `;

  const info = document.createElement("p");
  info.textContent = "You cannot access the chat anymore.";
  info.style.fontSize = "1rem";

  banDiv.appendChild(title);
  banDiv.appendChild(reason);
  banDiv.appendChild(info);
  chatPage.appendChild(banDiv);
});

// --- Reset favicon on focus ---
window.addEventListener("focus", () => {
  if (hasNewMessage) {
    setFavicon(defaultFavicon);
    hasNewMessage = false;
  }
});



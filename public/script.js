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

  // username validation: 2–18 characters
  if (username.length < 2 || username.length > 18) {
    return alert("Username must be between 2 and 18 characters.");
  }

  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("chatPage").classList.remove("hidden");

  socket.emit("join", username);
}

function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();

  // message validation: not empty & max 600 chars
  if (!message) return;
  if (message.length > 600) {
    return alert("Message cannot be longer than 600 characters.");
  }

  socket.emit("chat message", { user: username, text: message });
  input.value = "";
}

// --- Chat input Enter-to-send ---
document.getElementById("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault(); // stop newline
    sendMessage();
  }
});


// --- Send image function ---
function sendImage(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Block GIFs larger than 5 MB
  if (file.type === "image/gif" && file.size > 5 * 1024 * 1024) {
    alert("GIFs larger than 5 MB cannot be sent.");
    event.target.value = ""; // reset file input
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    socket.emit("chat message", { user: username, image: reader.result });
  };
  reader.readAsDataURL(file);

  // reset so same file can be re-uploaded
  event.target.value = "";
}

// --- Receive messages ---
socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  let displayName = data.user;
  if (data.user === "TemMoose") {
    displayName = "Tem";
    msgDiv.classList.add("tem");
  }

  if (data.user === "TristanGlizzy") {  // Glitchy user
    displayName = "Fishtan";
    msgDiv.classList.add("glitchy");
  }

  if (data.user === "BowdownP3asents") { // Wobbler user
    displayName = "Wobbler";
    msgDiv.classList.add("wobbler");
  }
  
  if (data.user === username) {
    msgDiv.classList.add("user");
  }

  // username label
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

// --- User list with displayName logic ---
socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");

  usersList.innerHTML = "";
  users.forEach(u => {
    let displayName = u;

    if (u === "TemMoose") displayName = "Tem";
    if (u === "TristanGlizzy") displayName = "Fishtan";
    if (u === "BowdownP3asents") displayName = "Wobbler";

    const div = document.createElement("div");
    div.textContent = displayName;

    // Apply styling classes for special users
    if (u === "TemMoose") div.classList.add("tem");
    if (u === "TristanGlizzy") div.classList.add("glitchy");
    if (u === "BowdownP3asents") div.classList.add("wobbler");

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




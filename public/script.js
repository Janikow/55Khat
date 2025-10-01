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

// --- Send image function ---
function sendImage(event) {
  const file = event.target.files[0];
  if (!file) return;

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

  if (data.user === "TristanGlizzy") {  // <-- replace with the username for glitch effect
    displayName = "Fishtan";
    msgDiv.classList.add("glitchy");
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


const socket = io();
let username = "";
let serverPort = "";
let profilePicData = "";
let usernameColor = "rgb(0, 255, 170)"; // Default color

// --- Favicon setup ---
const favicon = document.getElementById("favicon");
const defaultFavicon = "favicon.ico";
const alertFavicon = "favicon-alert.ico";
let hasNewMessage = false;
function setFavicon(src) { favicon.href = src; }

// --- RGB Slider Preview ---
const rSlider = document.getElementById("rSlider");
const gSlider = document.getElementById("gSlider");
const bSlider = document.getElementById("bSlider");
const colorPreview = document.getElementById("colorPreview");

function updateColorPreview() {
  usernameColor = `rgb(${rSlider.value}, ${gSlider.value}, ${bSlider.value})`;
  colorPreview.style.background = usernameColor;
}
if (rSlider && gSlider && bSlider) {
  [rSlider, gSlider, bSlider].forEach(slider => {
    slider.addEventListener("input", updateColorPreview);
  });
  updateColorPreview();
}

// --- Login / Register ---
function setUsername() {
  const nameInput = document.getElementById("usernameInput");
  const passInput = document.getElementById("passwordInput");
  const portInput = document.getElementById("serverPortInput");
  const picInput = document.getElementById("profilePicInput");

  username = nameInput.value.trim();
  const password = passInput.value.trim();
  serverPort = portInput.value.trim();

  if (username.length < 2 || username.length > 18)
    return alert("Username must be 2–18 characters.");
  if (!password)
    return alert("Please enter a password.");
  if (!serverPort)
    return alert("Please enter a server port.");

  if (picInput.files.length > 0) {
    const reader = new FileReader();
    reader.onload = () => {
      profilePicData = reader.result;
      sendLogin(username, password, serverPort, profilePicData);
    };
    reader.readAsDataURL(picInput.files[0]);
  } else {
    sendLogin(username, password, serverPort, "");
  }
}

function sendLogin(username, password, port, pfp) {
  socket.emit("login", { name: username, password, port, profilePic: pfp, color: usernameColor });
}

// --- Handle login result ---
socket.on("loginResult", (data) => {
  if (data.success) {
    document.getElementById("loginPage").classList.add("hidden");
    document.getElementById("chatPage").classList.remove("hidden");
  } else {
    alert(data.message);
  }
});

// --- Send message ---
function sendMessage() {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || message.length > 600) return;

  socket.emit("chat message", { user: username, text: message, color: usernameColor });
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
    socket.emit("chat message", { user: username, image: reader.result, color: usernameColor });
  reader.readAsDataURL(file);
  event.target.value = "";
}

// --- Receive chat messages ---
socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");
  if (data.user === username) msgDiv.classList.add("user");

  const headerDiv = document.createElement("div");
  headerDiv.classList.add("message-header");

  if (data.profilePic) {
    const img = document.createElement("img");
    img.src = data.profilePic;
    img.classList.add("profile-pic");
    headerDiv.appendChild(img);
  }

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("username");
  nameSpan.textContent = data.user;
  nameSpan.style.color = data.color || "var(--accent)";
  headerDiv.appendChild(nameSpan);

  msgDiv.appendChild(headerDiv);

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

// --- User list ---
socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");

  usersList.innerHTML = "";
  users.forEach((u) => {
    const div = document.createElement("div");
    div.classList.add("user-entry");

    if (u.profilePic) {
      const img = document.createElement("img");
      img.src = u.profilePic;
      img.classList.add("profile-pic");
      div.appendChild(img);
    }

    const span = document.createElement("span");
    span.textContent = u.name;
    span.style.color = u.color || "var(--accent)";
    div.appendChild(span);

    if (u.name === username) div.classList.add("self");
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

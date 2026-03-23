// ─── State ────────────────────────────────────────────────────────────────────
let username = "";
let serverPort = "";
let profilePicData = "";
let usernameColor = "rgb(0, 255, 170)";
let isConnected = false;
let typingTimeout = null;
let isCurrentlyTyping = false;

// Track which message IDs we've already rendered (dedup safety)
const renderedMessageIds = new Set();

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io({
  reconnectionAttempts: 10,
  reconnectionDelay: 1500,
});

// ─── Favicon ──────────────────────────────────────────────────────────────────
const favicon = document.getElementById("favicon");
const DEFAULT_FAVICON = "favicon.ico";
const ALERT_FAVICON = "favicon-alert.ico";

function setFavicon(src) {
  if (favicon) favicon.href = src;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showPage(page) {
  $("loginPage").classList.toggle("hidden", page !== "login");
  $("chatPage").classList.toggle("hidden", page !== "chat");
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Connection status ────────────────────────────────────────────────────────
function setStatus(msg, type = "info") {
  const el = $("connectionStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = `status-bar status-${type}`;
  el.classList.remove("hidden");
}

function hideStatus() {
  const el = $("connectionStatus");
  if (el) el.classList.add("hidden");
}

socket.on("connect", () => {
  isConnected = true;
  if (username && serverPort) {
    // Rejoin after reconnect
    socket.emit("login", {
      name: username,
      password: _storedPassword,
      port: serverPort,
      profilePic: profilePicData,
      color: usernameColor,
    });
    hideStatus();
    appendSystemMessage("Reconnected to server.");
  } else {
    hideStatus();
  }
});

socket.on("disconnect", (reason) => {
  isConnected = false;
  setStatus("Disconnected — reconnecting…", "error");
  console.warn("Disconnected:", reason);
});

socket.on("connect_error", () => {
  setStatus("Connection error — retrying…", "error");
});

// ─── Color sliders ────────────────────────────────────────────────────────────
const rSlider = $("rSlider");
const gSlider = $("gSlider");
const bSlider = $("bSlider");
const colorPreview = $("colorPreview");

function updateColorPreview() {
  usernameColor = `rgb(${rSlider.value}, ${gSlider.value}, ${bSlider.value})`;
  if (colorPreview) colorPreview.style.background = usernameColor;
  if (username) socket.emit("colorChange", usernameColor);
}

if (rSlider && gSlider && bSlider) {
  [rSlider, gSlider, bSlider].forEach((s) => s.addEventListener("input", updateColorPreview));
  updateColorPreview();
}

// ─── Login ────────────────────────────────────────────────────────────────────
// Stored temporarily for reconnect; never exposed in DOM
let _storedPassword = "";

function setUsername() {
  const nameInput = $("usernameInput");
  const passInput = $("passwordInput");
  const portInput = $("serverPortInput");
  const picInput = $("profilePicInput");
  const btn = $("loginBtn");

  const name = nameInput.value.trim();
  const password = passInput.value.trim();
  const port = portInput.value.trim();

  if (name.length < 2 || name.length > 18)
    return showLoginError("Username must be 2–18 characters.");
  if (!password)
    return showLoginError("Please enter a password.");
  if (!port)
    return showLoginError("Please enter a server port.");

  _storedPassword = password;

  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }

  const proceed = (pfp) => {
    profilePicData = pfp;
    socket.emit("login", {
      name,
      password,
      port,
      profilePic: pfp,
      color: usernameColor,
    });
  };

  if (picInput && picInput.files.length > 0) {
    const file = picInput.files[0];
    if (file.size > 2 * 1024 * 1024) {
      if (btn) { btn.disabled = false; btn.textContent = "Join"; }
      return showLoginError("Profile picture must be under 2MB.");
    }
    const reader = new FileReader();
    reader.onload = () => proceed(reader.result);
    reader.onerror = () => { showLoginError("Failed to read image."); };
    reader.readAsDataURL(file);
  } else {
    proceed("");
  }
}

function showLoginError(msg) {
  const el = $("loginError");
  if (el) {
    el.textContent = msg;
    el.classList.remove("hidden");
  } else {
    alert(msg);
  }
  const btn = $("loginBtn");
  if (btn) { btn.disabled = false; btn.textContent = "Join"; }
}

socket.on("loginResult", (data) => {
  const btn = $("loginBtn");
  if (data.success) {
    username = $("usernameInput").value.trim();
    serverPort = $("serverPortInput").value.trim();
    showPage("chat");
    $("chatInput").focus();
  } else {
    if (btn) { btn.disabled = false; btn.textContent = "Join"; }
    showLoginError(data.message || "Login failed.");
  }
});

// ─── Send message ─────────────────────────────────────────────────────────────
function sendMessage() {
  const input = $("chatInput");
  const message = input.value.trim();
  if (!message || message.length > 600) return;

  socket.emit("chat message", { text: message });
  input.value = "";

  // Stop typing indicator
  if (isCurrentlyTyping) {
    socket.emit("typing", false);
    isCurrentlyTyping = false;
  }
  clearTimeout(typingTimeout);
}

$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }

  // Typing indicator logic
  if (!isCurrentlyTyping) {
    isCurrentlyTyping = true;
    socket.emit("typing", true);
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isCurrentlyTyping = false;
    socket.emit("typing", false);
  }, 2500);
});

// ─── Send image ───────────────────────────────────────────────────────────────
function sendImage(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024)
    return alert("Images must be under 2MB.");

  const reader = new FileReader();
  reader.onload = () => {
    socket.emit("chat message", { image: reader.result });
  };
  reader.onerror = () => alert("Failed to read image.");
  reader.readAsDataURL(file);
  event.target.value = "";
}

// ─── Receive messages ─────────────────────────────────────────────────────────
socket.on("chat message", (data) => {
  // Deduplicate (safety for rapid reconnects)
  if (data.id && renderedMessageIds.has(data.id)) return;
  if (data.id) renderedMessageIds.add(data.id);

  appendMessage(data);
  clearTypingUser(data.user);

  if (document.hidden) setFavicon(ALERT_FAVICON);
});

function appendMessage(data) {
  const chatBox = $("chatBox");

  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");
  if (data.user === username) msgDiv.classList.add("own-message");

  // Header
  const headerDiv = document.createElement("div");
  headerDiv.classList.add("message-header");

  if (data.profilePic) {
    const img = document.createElement("img");
    img.src = data.profilePic;
    img.classList.add("profile-pic");
    img.alt = `${data.user}'s avatar`;
    headerDiv.appendChild(img);
  }

  const nameSpan = document.createElement("span");
  nameSpan.classList.add("username");
  // Store data-user for targeted color updates (never mix with message text)
  nameSpan.dataset.user = data.user;
  nameSpan.textContent = data.user;
  nameSpan.style.color = data.color || "var(--accent)";
  headerDiv.appendChild(nameSpan);

  if (data.timestamp) {
    const timeSpan = document.createElement("span");
    timeSpan.classList.add("message-time");
    timeSpan.textContent = formatTime(data.timestamp);
    headerDiv.appendChild(timeSpan);
  }

  msgDiv.appendChild(headerDiv);

  if (data.text) {
    const textSpan = document.createElement("span");
    textSpan.classList.add("message-text");
    textSpan.textContent = data.text; // textContent — safe, no XSS
    msgDiv.appendChild(textSpan);
  }

  if (data.image) {
    const img = document.createElement("img");
    img.src = data.image;
    img.classList.add("chat-image");
    img.alt = "Shared image";
    img.loading = "lazy";
    msgDiv.appendChild(img);
  }

  chatBox.appendChild(msgDiv);
  scrollToBottom();
}

function appendSystemMessage(text) {
  const chatBox = $("chatBox");
  const div = document.createElement("div");
  div.classList.add("system-message");
  div.textContent = text;
  chatBox.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const chatBox = $("chatBox");
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ─── Blocked message feedback ─────────────────────────────────────────────────
socket.on("chatBlocked", (data) => {
  showToast(data.reason || "Message blocked.", "error");
});

function showToast(msg, type = "info") {
  const container = $("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.classList.add("toast", `toast-${type}`);
  toast.textContent = msg;
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, 3000);
}

// ─── Typing indicators ────────────────────────────────────────────────────────
const typingUsers = new Set();
let typingClearTimers = {};

socket.on("typing", ({ user, isTyping }) => {
  if (user === username) return;

  if (isTyping) {
    typingUsers.add(user);
    clearTimeout(typingClearTimers[user]);
    // Auto-clear if we don't hear again within 4s (handles missed "false" events)
    typingClearTimers[user] = setTimeout(() => clearTypingUser(user), 4000);
  } else {
    clearTypingUser(user);
  }
  renderTypingIndicator();
});

function clearTypingUser(user) {
  typingUsers.delete(user);
  clearTimeout(typingClearTimers[user]);
  delete typingClearTimers[user];
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const el = $("typingIndicator");
  if (!el) return;
  const arr = Array.from(typingUsers);
  if (arr.length === 0) {
    el.textContent = "";
    el.classList.add("hidden");
  } else if (arr.length === 1) {
    el.textContent = `${arr[0]} is typing…`;
    el.classList.remove("hidden");
  } else if (arr.length === 2) {
    el.textContent = `${arr[0]} and ${arr[1]} are typing…`;
    el.classList.remove("hidden");
  } else {
    el.textContent = `${arr.length} people are typing…`;
    el.classList.remove("hidden");
  }
}

// ─── User list ────────────────────────────────────────────────────────────────
socket.on("user list", (users) => {
  const usersList = $("usersList");
  const userCount = $("userCount");
  if (!usersList) return;
  usersList.innerHTML = "";

  users.forEach((u) => {
    const div = document.createElement("div");
    div.classList.add("user-entry");
    div.dataset.user = u.name; // for targeted updates

    if (u.profilePic) {
      const img = document.createElement("img");
      img.src = u.profilePic;
      img.classList.add("profile-pic");
      img.alt = `${u.name}'s avatar`;
      div.appendChild(img);
    }

    const span = document.createElement("span");
    span.textContent = u.name;
    span.classList.add("username");
    span.dataset.user = u.name;
    span.style.color = u.color || "var(--accent)";
    div.appendChild(span);

    if (u.name === username) div.classList.add("self");
    usersList.appendChild(div);
  });

  if (userCount) userCount.textContent = users.length;
});

// ─── Color change ─────────────────────────────────────────────────────────────
// Use data-user attribute instead of textContent matching — prevents false matches
// when a username appears inside a message body.
socket.on("colorChange", ({ user, color }) => {
  document.querySelectorAll(`[data-user="${CSS.escape(user)}"]`).forEach((el) => {
    el.style.color = color;
  });
});

// ─── Ban ──────────────────────────────────────────────────────────────────────
socket.on("banned", (data) => {
  alert(`You were banned by ${data.by || "the server"}.`);
  window.location.reload();
});

// ─── Visibility / favicon ─────────────────────────────────────────────────────
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) setFavicon(DEFAULT_FAVICON);
});

// ─── Keyboard shortcut: Enter to submit login ─────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const loginPage = $("loginPage");
    if (loginPage && !loginPage.classList.contains("hidden")) {
      setUsername();
    }
  }
});

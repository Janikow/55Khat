const socket = io();
let username = "";

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

socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.classList.add("chat-message");

  let displayName = data.user;

  // Special rule for TemMoose
  if (data.user === "TemMoose") {
    displayName = "Tem";
    msgDiv.classList.add("tem"); // custom CSS class
  }

  if (data.user === username) {
    msgDiv.classList.add("user");
  }

  msgDiv.textContent = `${displayName}: ${data.text}`;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
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

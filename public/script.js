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
  if (data.user === username) msgDiv.classList.add("user");
  msgDiv.textContent = `${data.user}: ${data.text}`;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("user list", (users) => {
  const usersList = document.getElementById("usersList");
  const userCount = document.getElementById("userCount");
  usersList.innerHTML = "";
  users.forEach(u => {
    const div = document.createElement("div");
    div.textContent = u;
    usersList.appendChild(div);
  });
  userCount.textContent = users.length;
});

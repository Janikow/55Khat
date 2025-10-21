// Parse username from URL
const params = new URLSearchParams(window.location.search);
const username = params.get('username');
if (!username) {
  alert("No username provided.");
  window.location.href = "index.html";
}

// Socket.io connection
const socket = io();
socket.emit("join", username);

// Send chat message
function sendMessage() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit("chat message", { user: username, text: msg });
  input.value = "";
}

// Send image
function sendImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => socket.emit("chat message", { user: username, image: reader.result });
  reader.readAsDataURL(file);
  event.target.value = "";
}

// Receive chat messages
socket.on("chat message", (data) => {
  const chatBox = document.getElementById("chatBox");
  const msgDiv = document.createElement("div");
  msgDiv.textContent = data.text ? `${data.user}: ${data.text}` : `${data.user} sent an image`;
  if (data.image) {
    const img = document.createElement("img");
    img.src = data.image;
    img.style.maxWidth = "200px";
    img.style.borderRadius = "8px";
    msgDiv.appendChild(img);
  }
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
});

// Update user list
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

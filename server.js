const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Map of socket.id -> { name, ip, roomPin }
let users = {};
const bansFile = path.join(__dirname, "bans.json");

// Load banned IPs from file
let bannedIPs = {};
if (fs.existsSync(bansFile)) {
  try {
    bannedIPs = JSON.parse(fs.readFileSync(bansFile, "utf-8"));
    console.log("Loaded banned IPs:", bannedIPs);
  } catch (e) {
    console.error("Failed to load bans.json:", e);
  }
}

// Save banned IPs to file
function saveBans() {
  fs.writeFileSync(bansFile, JSON.stringify(bannedIPs, null, 2));
}

// Helper to get real client IP
function getClientIP(socket) {
  let ip = socket.handshake.address;
  if (socket.handshake.headers["x-forwarded-for"]) {
    ip = socket.handshake.headers["x-forwarded-for"].split(",")[0].trim();
  }
  return ip;
}

io.on("connection", (socket) => {
  const ip = getClientIP(socket);

  // Immediately disconnect banned users
  if (bannedIPs[ip]) {
    socket.emit("banned", { by: "server" });
    return socket.disconnect(true);
  }

  console.log(`User connected: ${socket.id} | IP: ${ip}`);

  // --- User joins a room ---
  socket.on("joinRoom", ({ username, roomPin }) => {
    socket.join(roomPin);
    socket.username = username;
    socket.roomPin = roomPin;
    users[socket.id] = { name: username, ip, roomPin };

    console.log(`${username} joined room ${roomPin}`);

    socket.emit("joinedRoom", { username, roomPin });
    io.to(roomPin).emit("systemMessage", `${username} has joined room ${roomPin}.`);

    // Update user list for this room only
    const roomUsers = Object.values(users)
      .filter(u => u.roomPin === roomPin)
      .map(u => u.name);
    io.to(roomPin).emit("user list", roomUsers);
  });

  // --- Handle chat messages ---
  socket.on("chat message", (msg) => {
    const sender = users[socket.id];
    if (!sender) return;

    const text = msg.text || "";
    const roomPin = sender.roomPin;

    // Admin-only commands
    if (sender.name === "TemMoose" && text.startsWith("/")) {
      const args = text.split(" ");
      const command = args[0].toLowerCase();
      const targetName = args[1];

      if (!targetName) return;

      const targetSocketEntry = Object.entries(users).find(
        ([, u]) => u.name === targetName
      );
      if (!targetSocketEntry) return;

      const [targetSocketId, targetUser] = targetSocketEntry;

      if (command === "/ban") {
        bannedIPs[targetUser.ip] = true;
        saveBans();
        io.to(targetSocketId).emit("banned", { by: sender.name });
        io.sockets.sockets.get(targetSocketId)?.disconnect(true);
        console.log(`${targetUser.name} was banned by ${sender.name}`);
      }

      if (command === "/unban") {
        if (bannedIPs[targetUser.ip]) {
          delete bannedIPs[targetUser.ip];
          saveBans();
          console.log(`${targetUser.name} was unbanned by ${sender.name}`);
        }
      }

      return;
    }

    // Normal message — only to users in same room
    io.to(roomPin).emit("chat message", msg);
  });

  // --- Handle disconnection ---
  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (!user) return;

    console.log(`${user.name} disconnected from room ${user.roomPin}`);

    delete users[socket.id];

    // Update user list in that room
    const roomUsers = Object.values(users)
      .filter(u => u.roomPin === user.roomPin)
      .map(u => u.name);

    io.to(user.roomPin).emit("user list", roomUsers);
    io.to(user.roomPin).emit("systemMessage", `${user.name} has left the chat.`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});







const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Map of socket.id -> { name, ip }
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

// Helper to get real client IP (works behind proxies)
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

  socket.on("join", (name) => {
    users[socket.id] = { name, ip };
    console.log(`${name} joined from ${ip}`);
    
    // Send full user list to everyone
    io.emit("user list", Object.values(users).map((u) => u.name));
  });

  socket.on("chat message", (msg) => {
    const sender = users[socket.id];
    if (!sender) return;

    const text = msg.text || "";

    // Handle admin commands
    if (sender.name === "TemMoose" && text.startsWith("/")) {
      const args = text.split(" ");
      const command = args[0].toLowerCase();
      const targetName = args[1];
      if (!targetName) return;

      // Find the target socket by username
      const targetSocketEntry = Object.entries(users).find(
        ([_, u]) => u.name === targetName
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

      return; // Don't broadcast command text
    }

    // Normal chat message
    console.log(`[${msg.user}] ${msg.text}`);
    io.emit("chat message", msg);
  });

  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log(`${users[socket.id].name} disconnected`);
      delete users[socket.id];
      io.emit("user list", Object.values(users).map((u) => u.name));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});








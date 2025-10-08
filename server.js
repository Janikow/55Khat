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

  socket.on("join", (name) => {
    users[socket.id] = { name, ip };
    console.log(`${name} joined from ${ip}`);
    io.emit("user list", Object.values(users).map((u) => u.name));
  });

  socket.on("chat message", (msg) => {
    const sender = users[socket.id];
    if (!sender) return;

    const text = msg.text || "";

    // === ADMIN COMMANDS ===
    if (sender.name === "TemMoose" && text.startsWith("/")) {
      const args = text.trim().split(" ");
      const command = args[0].toLowerCase();
      const targetArg = args[1];
      if (!targetArg) return;

      // ----- /BAN -----
      if (command === "/ban") {
        let targetIP = null;
        let targetSocketId = null;
        let targetName = null;

        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(targetArg)) {
          targetIP = targetArg;
        } else {
          const targetUser = Object.values(users).find((u) => u.name === targetArg);
          if (targetUser) {
            targetIP = targetUser.ip;
            targetSocketId = Object.keys(users).find(
              (id) => users[id].name === targetArg
            );
            targetName = targetUser.name;
          }
        }

        if (targetIP) {
          bannedIPs[targetIP] = true;
          saveBans();

          if (targetSocketId) {
            io.to(targetSocketId).emit("banned", { by: "server" });
            io.sockets.sockets.get(targetSocketId)?.disconnect(true);
          }

          const banMessage = `${targetName || targetIP} was banned.`;
          console.log(banMessage);
          io.emit("chat message", { user: "Server", text: banMessage });
        } else {
          console.log("Ban failed — user or IP not found.");
          io.emit("chat message", { user: "Server", text: "Ban failed — user or IP not found." });
        }

        return;
      }

      // ----- /UNBAN -----
      if (command === "/unban") {
        let targetIP = null;
        let targetName = null;

        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(targetArg)) {
          targetIP = targetArg;
        } else {
          const targetUser = Object.values(users).find((u) => u.name === targetArg);
          if (targetUser) {
            targetIP = targetUser.ip;
            targetName = targetUser.name;
          }
        }

        if (targetIP && bannedIPs[targetIP]) {
          delete bannedIPs[targetIP];
          saveBans();

          const unbanMessage = `${targetName || targetIP} was unbanned.`;
          console.log(unbanMessage);
          io.emit("chat message", { user: "Server", text: unbanMessage });
        } else {
          console.log("Unban failed — IP or user not found or not banned.");
          io.emit("chat message", { user: "Server", text: "Unban failed — IP or user not found or not banned." });
        }

        return;
      }

      return;
    }

    // === NORMAL CHAT ===
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

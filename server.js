const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Map of socket.id -> { name, ip, socket, port }
let users = {};
const bansFile = path.join(__dirname, "bans.json");

// Load banned IPs
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

// Helper to parse whisper target
function parseTargetAndRest(rest) {
  if (!rest) return { target: null, rest: null };
  const m = rest.match(/^(?:"([^"]+)"|(\S+))(?:\s+([\s\S]+))?$/);
  if (!m) return { target: null, rest: null };
  const target = m[1] || m[2];
  const remaining = m[3] || "";
  return { target, rest: remaining };
}

io.on("connection", (socket) => {
  const ip = getClientIP(socket);

  // Disconnect banned users
  if (bannedIPs[ip]) {
    socket.emit("banned", { by: "server" });
    return socket.disconnect(true);
  }

  console.log(`User connected: ${socket.id} | IP: ${ip}`);

  // --- JOIN EVENT ---
  socket.on("join", ({ name, port }) => {
    users[socket.id] = { name, ip, socket, port };
    socket.join(port);
    console.log(`${name} joined from ${ip} in server ${port}`);

    const roomUsers = Object.values(users)
      .filter(u => u.port === port)
      .map(u => u.name);

    io.to(port).emit("user list", roomUsers);
  });

  // --- CHAT MESSAGE ---
  socket.on("chat message", (msg) => {
    const sender = users[socket.id];
    if (!sender) return;

    const text = (msg.text || "").trim();

    // Command fallback
    if (text.startsWith("/")) {
      const cmdMatch = text.match(/^\/(\w+)\s*(.*)$/);
      if (!cmdMatch) return;

      const command = cmdMatch[1].toLowerCase();
      const after = cmdMatch[2].trim();

      if (command === "w" || command === "whisper") {
        const { target, rest } = parseTargetAndRest(after);
        if (!target || !rest) {
          socket.emit("chat message", { user: "Server", text: 'Usage: /w "Target Name" message' });
          return;
        }

        const targetSocketId = Object.keys(users).find(
          id => users[id].name === target && users[id].port === sender.port
        );

        if (!targetSocketId) {
          socket.emit("chat message", { user: "Server", text: `User "${target}" not found in this server.` });
          return;
        }

        const whisperPayload = { user: sender.name, text: rest, whisper: true, to: target };
        io.to(targetSocketId).emit("chat message", whisperPayload);
        socket.emit("chat message", whisperPayload);
        return;
      }

      return;
    }

    console.log(`[${msg.user}] (${sender.port}): ${msg.text}`);
    io.to(sender.port).emit("chat message", msg);
  });

  // --- WHISPER EVENT ---
  socket.on("whisper", ({ from, to, text }) => {
    const sender = Object.values(users).find(u => u.name === from && u.socket.id === socket.id);
    if (!sender) return;

    const targetSocketId = Object.keys(users).find(
      id => users[id].name === to && users[id].port === sender.port
    );
    if (!targetSocketId) {
      sender.socket.emit("chat message", { user: "Server", text: `User "${to}" not found in this server.` });
      return;
    }

    const payload = { user: from, text, whisper: true, to };
    io.to(targetSocketId).emit("chat message", payload);
    sender.socket.emit("chat message", payload);
    console.log(`${from} whispered to ${to} (${sender.port}): ${text}`);
  });

  // --- BAN EVENT ---
  socket.on("ban", ({ from, target }) => {
    const sender = Object.values(users).find(u => u.name === from && u.socket.id === socket.id);
    if (!sender || sender.name !== "TemMoose") return;

    const port = sender.port;

    // IP-like target
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
      const targetIP = target;
      bannedIPs[targetIP] = true;
      saveBans();
      const targetSocketId = Object.keys(users).find(id => users[id].ip === targetIP);
      if (targetSocketId) {
        io.to(targetSocketId).emit("banned", { by: sender.name });
        io.sockets.sockets.get(targetSocketId)?.disconnect(true);
      }
      const msg = `${targetIP} was banned.`;
      console.log(msg);
      io.to(port).emit("chat message", { user: "Server", text: msg });
      return;
    }

    // Username target
    const targetSocketId = Object.keys(users).find(
      id => users[id].name === target && users[id].port === port
    );
    if (!targetSocketId) {
      io.to(port).emit("chat message", { user: "Server", text: "Ban failed — user not found." });
      return;
    }

    const targetIP = users[targetSocketId].ip;
    bannedIPs[targetIP] = true;
    saveBans();
    io.to(targetSocketId).emit("banned", { by: sender.name });
    io.sockets.sockets.get(targetSocketId)?.disconnect(true);
    const msg = `${target} was banned.`;
    console.log(msg);
    io.to(port).emit("chat message", { user: "Server", text: msg });
  });

  // --- UNBAN EVENT ---
  socket.on("unban", ({ from, target }) => {
    const sender = Object.values(users).find(u => u.name === from && u.socket.id === socket.id);
    if (!sender || sender.name !== "TemMoose") return;

    const port = sender.port;

    // IP target
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
      if (bannedIPs[target]) {
        delete bannedIPs[target];
        saveBans();
        const msg = `${target} was unbanned.`;
        console.log(msg);
        io.to(port).emit("chat message", { user: "Server", text: msg });
      } else {
        io.to(port).emit("chat message", { user: "Server", text: `Unban failed — ${target} not banned.` });
      }
      return;
    }

    // Username target
    const targetSocketId = Object.keys(users).find(
      id => users[id].name === target && users[id].port === port
    );
    let targetIP = targetSocketId ? users[targetSocketId].ip : null;

    if (targetIP && bannedIPs[targetIP]) {
      delete bannedIPs[targetIP];
      saveBans();
      const msg = `${target} was unbanned.`;
      console.log(msg);
      io.to(port).emit("chat message", { user: "Server", text: msg });
    } else if (bannedIPs[target]) {
      delete bannedIPs[target];
      saveBans();
      const msg = `${target} was unbanned.`;
      console.log(msg);
      io.to(port).emit("chat message", { user: "Server", text: msg });
    } else {
      io.to(port).emit("chat message", { user: "Server", text: "Unban failed — IP or user not found or not banned." });
    }
  });

  // --- DISCONNECT EVENT ---
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      const port = users[socket.id].port;
      console.log(`${users[socket.id].name} disconnected from ${port}`);
      delete users[socket.id];
      const roomUsers = Object.values(users)
        .filter(u => u.port === port)
        .map(u => u.name);
      io.to(port).emit("user list", roomUsers);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

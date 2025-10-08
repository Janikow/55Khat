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
let bannedIPs = [];
if (fs.existsSync(bansFile)) {
  bannedIPs = JSON.parse(fs.readFileSync(bansFile, "utf-8"));
}

// Middleware to get IPs
io.use((socket, next) => {
  const ip =
    socket.handshake.headers["x-forwarded-for"] ||
    socket.handshake.address;
  if (bannedIPs.includes(ip)) {
    return next(new Error("banned"));
  }
  socket.ip = ip;
  next();
});

// Handle connections
io.on("connection", (socket) => {
  const ip = socket.ip;
  console.log(`New connection from ${ip}`);

  socket.on("join", (name) => {
    // Check if name is already taken (case-insensitive)
    const nameTaken = Object.values(users).some(
      (u) => u.name.toLowerCase() === name.toLowerCase()
    );
    if (nameTaken) {
      socket.emit("username taken");
      return;
    }

    // Save user
    users[socket.id] = { name, ip };
    console.log(`${name} joined from ${ip}`);

    io.emit("user list", Object.values(users).map((u) => u.name));

    // Tell user their join was successful
    socket.emit("join success");
  });

  socket.on("message", (msg) => {
    const user = users[socket.id];
    if (user) {
      io.emit("message", { name: user.name, text: msg });
    }
  });

  socket.on("ban", (username) => {
    const target = Object.entries(users).find(
      ([, u]) => u.name === username
    );
    if (target) {
      const [targetId, targetData] = target;
      bannedIPs.push(targetData.ip);
      fs.writeFileSync(bansFile, JSON.stringify(bannedIPs, null, 2));
      io.to(targetId).emit("banned");
      io.sockets.sockets.get(targetId)?.disconnect(true);
      delete users[targetId];
      io.emit("user list", Object.values(users).map((u) => u.name));
      console.log(`${username} has been banned.`);
    }
  });

  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log(`${users[socket.id].name} disconnected`);
      delete users[socket.id];
      io.emit("user list", Object.values(users).map((u) => u.name));
    }
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Map of socket.id -> { name, ip, socket, port, profilePic, color }
let users = {};
const bansFile = path.join(__dirname, "bans.json");
const usersFile = path.join(__dirname, "users.json");

let bannedIPs = fs.existsSync(bansFile) ? JSON.parse(fs.readFileSync(bansFile, "utf-8")) : {};
let registeredUsers = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, "utf-8")) : {};

function saveBans() {
  fs.writeFileSync(bansFile, JSON.stringify(bannedIPs, null, 2));
}

function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(registeredUsers, null, 2));
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function getClientIP(socket) {
  let ip = socket.handshake.address;
  if (socket.handshake.headers["x-forwarded-for"]) {
    ip = socket.handshake.headers["x-forwarded-for"].split(",")[0].trim();
  }
  return ip;
}

io.on("connection", (socket) => {
  const ip = getClientIP(socket);
  if (bannedIPs[ip]) {
    socket.emit("banned", { by: "server" });
    return socket.disconnect(true);
  }

  socket.on("login", ({ name, password, port, profilePic, color }) => {
    if (!name || !password)
      return socket.emit("loginResult", { success: false, message: "Missing username or password." });

    const hashed = hashPassword(password);

    if (registeredUsers[name]) {
      if (registeredUsers[name].password !== hashed)
        return socket.emit("loginResult", { success: false, message: "Incorrect password." });
      if (profilePic) registeredUsers[name].profilePic = profilePic;
    } else {
      registeredUsers[name] = { password: hashed, profilePic: profilePic || "" };
      saveUsers();
      console.log(`Registered new user: ${name}`);
    }

    users[socket.id] = {
      name,
      ip,
      socket,
      port,
      profilePic: registeredUsers[name].profilePic,
      color: color || "rgb(255,255,255)" // default color
    };

    socket.join(port);

    const roomUsers = Object.values(users)
      .filter(u => u.port === port)
      .map(u => ({ name: u.name, profilePic: u.profilePic, color: u.color }));

    io.to(port).emit("user list", roomUsers);
    socket.emit("loginResult", { success: true });
  });

  socket.on("chat message", (msg) => {
    const sender = users[socket.id];
    if (!sender) return;
    const payload = {
      user: sender.name,
      text: msg.text,
      image: msg.image,
      profilePic: sender.profilePic,
      color: sender.color
    };
    io.to(sender.port).emit("chat message", payload);
  });

  // 🟢 Handle live color change
  socket.on("colorChange", (newColor) => {
    const user = users[socket.id];
    if (user) {
      user.color = newColor;

      // Update everyone in the same room
      io.to(user.port).emit("colorChange", {
        user: user.name,
        color: newColor
      });

      // Also refresh user list with new color
      const roomUsers = Object.values(users)
        .filter(u => u.port === user.port)
        .map(u => ({ name: u.name, profilePic: u.profilePic, color: u.color }));
      io.to(user.port).emit("user list", roomUsers);
    }
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      const port = user.port;
      delete users[socket.id];
      const roomUsers = Object.values(users)
        .filter(u => u.port === port)
        .map(u => ({ name: u.name, profilePic: u.profilePic, color: u.color }));
      io.to(port).emit("user list", roomUsers);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));


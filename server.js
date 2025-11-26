const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

// 🔒 Prevent large Base64 messages from disconnecting clients
const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024 // 2MB limit
});

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

// Safe wrapper to prevent server crashes
function safe(fn) {
  return (...args) => {
    try { fn(...args); }
    catch (err) { console.error("Socket handler error:", err); }
  };
}

// ----------------------------
// 🔥 WORD LISTS (3 categories)
// ----------------------------

// General profanity (mild → strong)
const profanityWords = [
  "arse",
  "arsehead",
  "arsehole",
  "ass",
  "asshole",
  "ass hole",
  "bastard",
  "bitch",
  "bollocks",
  "bullshit",
  "crap",
  "dammit",
  "damned",
  "dick",
  "dickhead",
  "dick-head",
  "dumbass",
  "dumb ass",
  "dumb-ass",
  "hell",
  "holyshit",
  "horseshit",
  "inshit"
];

// Hate speech / slurs
const slurWords = [
  "fag",
  "faggot",
  "nigga",
  "nigra",
  "elijah",
  "logan"
];

// Sexual / explicit content
const sexualWords = [
  "childfucker",
  "child-fucker",
  "cock",
  "cocksucker",
  "cunt",
  "fatherfucker",
  "father-fucker",
  "fuck",
  "fucked",
  "fucker",
  "fucking",
  "godsdamn",
  "goddamn",
  "god damn",
  "goddammit",
  "goddamnit",
  "goddamned",
  "motherfucker",
  "mother fucker",
  "mother-fucker",
  "sex"
];


// ------------------------------------
// 🔧 Normalization (bypass prevention)
// ------------------------------------
function normalizeChat(text) {
  if (!text) return "";

  let str = text.toLowerCase();

  // Normalize unicode (stops Cyrillic tricks)
  str = str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  // Replace numbers used as letters
  const leetspeak = {
    "4": "a",
    "@": "a",
    "8": "b",
    "3": "e",
    "6": "g",
    "1": "i",
    "!": "i",
    "0": "o",
    "5": "s",
    "$": "s",
    "7": "t",
  };
  str = str.replace(/[4836!105$7@]/g, (m) => leetspeak[m] || m);

  // Remove ALL non-letters
  str = str.replace(/[^a-z]/g, "");

  return str;
}


// -----------------------------------
// 🛑 FILTER SYSTEM — multi-category
// -----------------------------------
function filterMessage(text) {
  if (!text) return { allowed: true, reason: "" };

  const cleaned = normalizeChat(text);

  // Check profanity
  for (let w of profanityWords) {
    if (cleaned.includes(w.replace(/[^a-z]/g, ""))) {
      return {
        allowed: false,
        reason: "Thats mean."
      };
    }
  }

  // Check sexual content
  for (let w of sexualWords) {
    if (cleaned.includes(w.replace(/[^a-z]/g, ""))) {
      return {
        allowed: false,
        reason: "Perv."
      };
    }
  }

  // Check hate speech
  for (let w of slurWords) {
    if (cleaned.includes(w.replace(/[^a-z]/g, ""))) {
      return {
        allowed: false,
        reason: "E"
      };
    }
  }

  return { allowed: true, reason: "" };
}


io.on("connection", (socket) => {
  const ip = getClientIP(socket);

  if (bannedIPs[ip]) {
    socket.emit("banned", { by: "server" });
    return socket.disconnect(true);
  }

  socket.on("login", safe(({ name, password, port, profilePic, color }) => {
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
      color: color || "rgb(255,255,255)"
    };

    socket.join(port);

    const roomUsers = Object.values(users)
      .filter(u => u.port === port)
      .map(u => ({ name: u.name, profilePic: u.profilePic, color: u.color }));

    io.to(port).emit("user list", roomUsers);
    socket.emit("loginResult", { success: true });
  }));

  socket.on("chat message", safe((msg) => {
    const sender = users[socket.id];
    if (!sender) return;

    // Block oversized Base64 data
    if (msg.image && msg.image.length > 2_000_000)
      return;

    // 🔒 Chat filter check
    const filter = filterMessage(msg.text);
    if (!filter.allowed) {
      socket.emit("chatBlocked", { reason: filter.reason });
      return;
    }

    const payload = {
      user: sender.name,
      text: msg.text,
      image: msg.image,
      profilePic: sender.profilePic,
      color: sender.color
    };
    io.to(sender.port).emit("chat message", payload);
  }));

  // 🟢 Handle live color change
  socket.on("colorChange", safe((newColor) => {
    const user = users[socket.id];
    if (user) {
      user.color = newColor;

      io.to(user.port).emit("colorChange", {
        user: user.name,
        color: newColor
      });

      const roomUsers = Object.values(users)
        .filter(u => u.port === user.port)
        .map(u => ({ name: u.name, profilePic: u.profilePic, color: u.color }));
      io.to(user.port).emit("user list", roomUsers);
    }
  }));

  socket.on("disconnect", safe(() => {
    const user = users[socket.id];
    if (user) {
      const port = user.port;
      delete users[socket.id];
      const roomUsers = Object.values(users)
        .filter(u => u.port === port)
        .map(u => ({ name: u.name, profilePic: u.profilePic, color: u.color }));
      io.to(port).emit("user list", roomUsers);
    }
  }));
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));



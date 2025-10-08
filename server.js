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

/*
  Helper to parse a command target and the rest of the text.
  Accepts:
    - quoted names: "A Name With Spaces"
    - single-word names: singleWord
    - IP addresses (for ban/unban)
  Returns { target: string|null, rest: string|null }
*/
function parseTargetAndRest(rest) {
  // rest may be empty
  if (!rest) return { target: null, rest: null };

  // match: "quoted name" <rest...> OR singleword <rest...>
  const m = rest.match(/^(?:"([^"]+)"|(\S+))(?:\s+([\s\S]+))?$/);
  if (!m) return { target: null, rest: null };
  const target = m[1] || m[2];
  const remaining = m[3] || "";
  return { target, rest: remaining };
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

    const text = (msg.text || "").trim();

    // COMMAND PARSING: any message starting with "/" is a command
    if (text.startsWith("/")) {
      const cmdMatch = text.match(/^\/(\w+)\s*(.*)$/);
      if (!cmdMatch) return;

      const command = cmdMatch[1].toLowerCase();
      const after = cmdMatch[2].trim();

      // === WHISPER: /w "target name" message OR /w target message ===
      if (command === "w" || command === "whisper") {
        const { target, rest } = parseTargetAndRest(after);
        if (!target) {
          // tell sender about incorrect usage
          socket.emit("chat message", { user: "Server", text: 'Usage: /w "Target Name" message' });
          return;
        }
        if (!rest) {
          socket.emit("chat message", { user: "Server", text: 'Usage: /w "Target Name" message' });
          return;
        }

        // find target socket id (exact match)
        const targetSocketId = Object.keys(users).find(id => users[id].name === target);
        if (!targetSocketId) {
          socket.emit("chat message", { user: "Server", text: `User "${target}" not found.` });
          return;
        }

        // emit message only to sender and target; mark it as a whisper so clients can style it
        const whisperPayload = { user: sender.name, text: rest, whisper: true, to: target };
        io.to(targetSocketId).emit("chat message", whisperPayload);
        socket.emit("chat message", whisperPayload); // sender also sees their own whisper
        return;
      }

      // === ADMIN COMMANDS: only TemMoose can /ban and /unban ===
      if (sender.name === "TemMoose") {
        if (command === "ban") {
          const { target, rest } = parseTargetAndRest(after);
          if (!target) {
            socket.emit("chat message", { user: "Server", text: 'Usage: /ban "Target Name" OR /ban 1.2.3.4' });
            return;
          }

          // if target is IP-like, use it
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
            const targetIP = target;
            bannedIPs[targetIP] = true;
            saveBans();
            // kick any sockets from that IP
            const targetSocketId = Object.keys(users).find(id => users[id].ip === targetIP);
            if (targetSocketId) {
              io.to(targetSocketId).emit("banned", { by: sender.name });
              io.sockets.sockets.get(targetSocketId)?.disconnect(true);
            }
            const banMessage = `${targetIP} was banned.`;
            console.log(banMessage);
            io.emit("chat message", { user: "Server", text: banMessage });
            return;
          }

          // otherwise treat as username
          const targetName = target;
          const targetSocketId = Object.keys(users).find(id => users[id].name === targetName);
          let targetIP = null;
          if (targetSocketId) {
            targetIP = users[targetSocketId].ip;
          }

          if (targetIP) {
            bannedIPs[targetIP] = true;
            saveBans();
            io.to(targetSocketId).emit("banned", { by: sender.name });
            io.sockets.sockets.get(targetSocketId)?.disconnect(true);
            const banMessage = `${targetName} was banned.`;
            console.log(banMessage);
            io.emit("chat message", { user: "Server", text: banMessage });
          } else {
            console.log("Ban failed — user or IP not found.");
            io.emit("chat message", { user: "Server", text: "Ban failed — user or IP not found." });
          }

          return;
        }

        if (command === "unban") {
          const { target, rest } = parseTargetAndRest(after);
          if (!target) {
            socket.emit("chat message", { user: "Server", text: 'Usage: /unban "Target Name" OR /unban 1.2.3.4' });
            return;
          }

          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
            const targetIP = target;
            if (bannedIPs[targetIP]) {
              delete bannedIPs[targetIP];
              saveBans();
              const unbanMessage = `${targetIP} was unbanned.`;
              console.log(unbanMessage);
              io.emit("chat message", { user: "Server", text: unbanMessage });
            } else {
              io.emit("chat message", { user: "Server", text: `Unban failed — ${targetIP} not banned.` });
            }
            return;
          }

          const targetName = target;
          const targetSocketId = Object.keys(users).find(id => users[id].name === targetName);
          let targetIP = null;
          if (targetSocketId) targetIP = users[targetSocketId].ip;

          // if we found an online user's IP, unban it. Otherwise, attempt to find a banned IP by scanning bannedIPs maybe by name? (not possible)
          if (targetIP && bannedIPs[targetIP]) {
            delete bannedIPs[targetIP];
            saveBans();
            const unbanMessage = `${targetName} was unbanned.`;
            console.log(unbanMessage);
            io.emit("chat message", { user: "Server", text: unbanMessage });
          } else {
            // fallback: check if target argument itself is a banned IP
            if (bannedIPs[targetName]) {
              delete bannedIPs[targetName];
              saveBans();
              const unbanMessage = `${targetName} was unbanned.`;
              console.log(unbanMessage);
              io.emit("chat message", { user: "Server", text: unbanMessage });
            } else {
              console.log("Unban failed — IP or user not found or not banned.");
              io.emit("chat message", { user: "Server", text: "Unban failed — IP or user not found or not banned." });
            }
          }

          return;
        }
      } // end admin block

      // If command reached here and wasn't handled, notify sender
      socket.emit("chat message", { user: "Server", text: `Unknown command: ${command}` });
      return;
    } // end commands

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
